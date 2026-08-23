// The bridge: every JS↔native message and every byte of HTTP, in one file.
//
// This file is the egress choke point. The audit for "nothing leaves the
// box" is: the only two URLs this process can reach are the loopback bases
// below; redirects are refused; the webviews themselves can load only
// file: URLs (Windows.swift + each page's CSP). If a future edit adds a
// third base or follows a redirect, it should have to happen HERE, loudly.
import AppKit
import WebKit

protocol BridgeDelegate: AnyObject {
  func openChat()
  func openChat(with utterance: String)
  func takePendingUtterance() -> String
  func takePendingVoiceNote() -> String
  func armVoice()
  func voiceTranscript(_ utterance: String)
  func voiceNote(_ message: String)
  func setOrbTalking(_ talking: Bool)
  func setOrbFace(_ face: String)
  func speakAnswer(_ text: String)
  func openConnections()
  func openPeople()
  func openSky()
  func closeWindow(of webView: WKWebView)
  func dragWindow(of webView: WKWebView)
  func motionAnywayChanged(_ on: Bool)
  func soundsChanged(_ on: Bool)
  func scaleChanged(_ scale: Double, committed: Bool, from webView: WKWebView?)
  func fitPopup(_ webView: WKWebView, contentHeight: Double, extraWidth: Double)
  func widgetSpot() -> [String: Double]
  func spotlightWidget(_ on: Bool)
  func openOnboarding()
}

final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, URLSessionTaskDelegate {

  // The faces the widget page knows how to wear. Allow-listed here rather
  // than passed through, because this string is interpolated into JavaScript
  // on the other side — an unrecognised value must never reach it.
  static let orbFaces: Set<String> = ["idle", "notify", "listening", "talking"]

  // The per-app Reduce Motion override. macOS Reduce Motion is a SYSTEM
  // accessibility setting and the widget honours it by default; this is the
  // ordinary per-app opt-back-in for someone who wants the animation anyway.
  // Both prefs live in native storage because the webviews are configured
  // .nonPersistent() (Windows.swift), so nothing a page stores survives a
  // relaunch. Default false: a fresh install always respects the setting.
  static let motionDefaultsKey = "HazlieMotionAnyway"
  static var motionAnyway: Bool {
    get { UserDefaults.standard.bool(forKey: motionDefaultsKey) }
    set { UserDefaults.standard.set(newValue, forKey: motionDefaultsKey) }
  }

  // Whether the welcome flow has been completed. False on a fresh install,
  // which is what makes onboarding open by itself the first time.
  static let onboardedDefaultsKey = "HazlieOnboarded"
  static var onboarded: Bool {
    get { UserDefaults.standard.bool(forKey: onboardedDefaultsKey) }
    set { UserDefaults.standard.set(newValue, forKey: onboardedDefaultsKey) }
  }

  // Interface sounds. Unlike Reduce Motion there is no system setting to
  // inherit, so this defaults ON — and an absent key has to be checked for
  // explicitly, because UserDefaults reads a missing Bool as false and would
  // otherwise ship every fresh install silent.
  static let soundsDefaultsKey = "HazlieSounds"
  static var soundsOn: Bool {
    get {
      guard UserDefaults.standard.object(forKey: soundsDefaultsKey) != nil else { return true }
      return UserDefaults.standard.bool(forKey: soundsDefaultsKey)
    }
    set { UserDefaults.standard.set(newValue, forKey: soundsDefaultsKey) }
  }

  // How big the widget is drawn. One number: the widget window, both popups
  // and every page's zoom are all derived from it (main.swift applyScale), so
  // the whole surface grows together rather than the panel growing around a
  // fixed-size layout.
  //
  // Absent has to be checked for explicitly — UserDefaults reads a missing
  // Double as 0, and a fresh install would open at zero size with no window
  // to fix it from. Clamped on both read and write: the value crosses the
  // bridge from a page, and out-of-range is what makes a borderless window
  // unreachable.
  static let scaleDefaultsKey = "HazlieScale"
  static let scaleRange: ClosedRange<Double> = 0.7...1.6
  static var scale: Double {
    get {
      guard UserDefaults.standard.object(forKey: scaleDefaultsKey) != nil else { return 1 }
      return clampScale(UserDefaults.standard.double(forKey: scaleDefaultsKey))
    }
    set { UserDefaults.standard.set(clampScale(newValue), forKey: scaleDefaultsKey) }
  }
  static func clampScale(_ v: Double) -> Double {
    guard v.isFinite else { return 1 }
    return min(max(v, scaleRange.lowerBound), scaleRange.upperBound)
  }

  // The handoff out of onboarding: after the flow finishes, the widget's
  // gear nudges until settings is opened once, and that first open runs the
  // connectors intro. Reset by every completed flow, so replay hands off
  // like the first time.
  static let connectorsIntroKey = "HazlieConnectorsIntro"
  static var connectorsIntroDone: Bool {
    get { UserDefaults.standard.bool(forKey: connectorsIntroKey) }
    set { UserDefaults.standard.set(newValue, forKey: connectorsIntroKey) }
  }

  // Which connectors have already hand-held — by KIND (both mail accounts
  // are one "mail"), persisted natively because the webviews forget
  // everything at relaunch. A connector's first press walks the user
  // through; every later press is the compact hint.
  static let handheldKey = "HazlieHandheld"
  static var handheld: [String] {
    get { UserDefaults.standard.stringArray(forKey: handheldKey) ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: handheldKey) }
  }

  // Grant mic capture to our own ear page only; the OS-level TCC prompt for
  // Hazlie.app still gates the first use. Any other origin is denied.
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    let own = origin.protocol == AssetSchemeHandler.scheme
    decisionHandler(own && type == .microphone ? .grant : .deny)
  }
  weak var delegate: BridgeDelegate?

  // The ONLY two places this process may talk to.
  private let hermesBase = URL(string: "http://127.0.0.1:8789")!
  private let connectBase: URL = {
    // Dev override for the port ONLY — the host is not configurable. Lets a
    // second connect instance (e.g. --port 8790 from a worktree) serve the
    // widget without touching the launchd one.
    var port = 8788
    if let s = ProcessInfo.processInfo.environment["HAZLIE_CONNECT_PORT"],
       let p = Int(s), (1024...65535).contains(p) { port = p }
    return URL(string: "http://127.0.0.1:\(port)")!
  }()

  private lazy var session: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 120 // a buffered 8B answer is legitimately slow
    cfg.httpShouldSetCookies = false
    return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
  }()

  private var askTask: URLSessionDataTask?
  // The transcript (not typed text) still waiting for its ask; the ask that
  // carries this exact text also hands its answer back to the ear page for
  // speech. Matched by text rather than a bare flag: the chat page drops an
  // incoming transcript while a typed ask is busy, and a flag would then
  // hand the TYPED question's answer to the speaker.
  private var pendingVoiceUtterance: String?

  // The only external destinations this app will hand to the OS. Opening
  // one launches the default browser (or System Settings) — the app itself
  // still opens no socket beyond loopback; the user's click on a fixed help
  // link is what leaves, same posture as the connect page's help topics.
  private let allowedExternal: Set<String> = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "https://myaccount.google.com/apppasswords",
    "https://granola.ai",
    "https://cloud.ouraring.com/oauth/applications",
    "https://www.notion.so/my-integrations",
    // The bridge token how-to links, for the Discord/Slack guided login flows.
    "https://docs.mau.fi/bridges/go/discord/authentication.html",
    "https://docs.mau.fi/bridges/go/slack/authentication.html",
  ]

  // Refuse every redirect: a redirect is how a compromised loopback response
  // would move the bearer token somewhere else.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  // THE SIZE HAS TO BE APPLIED HERE, not next to the load.
  //
  // pageZoom is reset by navigation, and makeWebView starts the load before
  // it returns — so every caller that sets pageZoom on the webview it was
  // just handed is racing the first commit and quietly loses. That is what
  // shipped: the widget WINDOW came back at the stored size on relaunch while
  // the page inside it drew at 100%, which reads exactly like a widget being
  // constrained by a box that grew around it.
  //
  // Doing it on didFinish covers the first load and every reload, for every
  // page, and callers no longer have to remember. Live changes still go
  // through scaleChanged, which is the case this cannot see.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.pageZoom = Bridge.scale
  }

  // Webviews may navigate to file: URLs and nowhere else.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let ok = url?.isFileURL == true || url?.scheme == AssetSchemeHandler.scheme
    decisionHandler(ok ? .allow : .cancel)
  }

  // MARK: messages

  private func dbg(_ line: String) {
    guard ProcessInfo.processInfo.environment["HAZLIE_DEBUG_ARM"] == "1" else { return }
    let f = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/logs/widget-asset.log")
    let msg = "bridge: " + line + "\n"
    if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(msg.data(using: .utf8)!); try? h.close() }
    else { try? msg.write(to: f, atomically: true, encoding: .utf8) }
  }

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "hz",
          let body = message.body as? [String: Any],
          let id = body["id"] as? Int,
          let type = body["type"] as? String,
          let webView = message.webView
    else { dbg("DROPPED message: \(String(describing: message.body).prefix(120))"); return }
    dbg("recv \(type)")
    let payload = body["payload"] as? [String: Any] ?? [:]

    switch type {
    case "openChat":
      delegate?.openChat()
      reply(webView, id, ["state": "ok"])
    case "openChatWith":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      if !utterance.isEmpty { delegate?.openChat(with: utterance) }
      reply(webView, id, ["state": "ok"])
    case "chatReady":
      reply(webView, id, [
        "state": "ok",
        "pending": delegate?.takePendingUtterance() ?? "",
        "note": { let n = delegate?.takePendingVoiceNote() ?? ""; self.dbg("chatReady note='\(n.prefix(40))'"); return n }(),
      ])
    case "voiceArm":
      delegate?.armVoice()
      reply(webView, id, ["state": "ok"])
    case "voiceTranscript":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      if !utterance.isEmpty {
        pendingVoiceUtterance = utterance
        delegate?.voiceTranscript(utterance)
      }
      reply(webView, id, ["state": "ok"])
    case "voiceError":
      dbg("voiceError msg='\((payload["message"] as? String ?? "").prefix(60))'")
      delegate?.voiceNote(payload["message"] as? String ?? "voice error")
      reply(webView, id, ["state": "ok"])
    case "orbState":
      // The ear now names the face it wants — idle, listening or talking —
      // because a single boolean could not tell "Hazlie is speaking" from
      // "the mic is open and the owner is". The boolean is still read as the
      // fallback, so an older ear page keeps working unchanged.
      if let face = payload["state"] as? String, Bridge.orbFaces.contains(face) {
        delegate?.setOrbFace(face)
      } else {
        delegate?.setOrbTalking(payload["talking"] as? Bool ?? false)
      }
      reply(webView, id, ["state": "ok"])
    case "openConnections":
      delegate?.openConnections()
      reply(webView, id, ["state": "ok"])
    case "openSky":
      delegate?.openSky()
      reply(webView, id, ["state": "ok"])
    case "openPeople":
      delegate?.openPeople()
      reply(webView, id, ["state": "ok"])
    case "widgetSpot":
      // Where the widget sits inside the onboarding window, as FRACTIONS of
      // that window rather than points. The page multiplies by its own
      // innerWidth/innerHeight, which makes the answer immune to pageZoom —
      // points would have to be divided by a zoom the page does not know.
      var spot = delegate?.widgetSpot() ?? [:]
      spot["state"] = 1
      reply(webView, id, spot)
    case "spotlightWidget":
      delegate?.spotlightWidget(payload["on"] as? Bool ?? false)
      reply(webView, id, ["state": "ok"])
    case "moveToApplications":
      // The app moves ITSELF — onboarding offers a button, not a Finder
      // tutorial. Copy the bundle to /Applications, hand a detached shell the
      // job of opening the new copy (detached, because the open must survive
      // this process quitting), remember the old path for the new instance to
      // delete, and terminate. Works from ~/Downloads and from a read-only
      // DMG alike; the copy is what breaks out of Gatekeeper's translocated
      // path.
      let src = Bundle.main.bundleURL
      let dst = URL(fileURLWithPath: "/Applications/Intaglio Labs.app")
      if src.path == dst.path || src.path.hasPrefix("/Applications/") {
        reply(webView, id, ["state": "ok", "moved": false]) // nothing to do
        break
      }
      do {
        let fm = FileManager.default
        try? fm.removeItem(at: dst)
        try fm.copyItem(at: src, to: dst)
        // The new instance deletes the copy we are running from — this one
        // cannot delete itself and then keep running long enough to relaunch.
        UserDefaults.standard.set(src.path, forKey: "HazlieStaleCopyPath")
        reply(webView, id, ["state": "ok", "moved": true])
        let relauncher = Process()
        relauncher.executableURL = URL(fileURLWithPath: "/bin/sh")
        relauncher.arguments = ["-c", "sleep 1; /usr/bin/open '/Applications/Intaglio Labs.app'"]
        try? relauncher.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          NSApp.terminate(nil)
        }
      } catch {
        reply(webView, id, ["state": "error", "error": "copy failed: \(error.localizedDescription)"])
      }
    case "openOnboarding":
      delegate?.openOnboarding()
      reply(webView, id, ["state": "ok"])
    case "onboardingDone":
      // Only the flow finishing sets this. Dismissing with Escape closes the
      // window without sending it, so a flow backed out of returns next time.
      Bridge.onboarded = true
      // ...and the handoff arms: the gear will nudge until settings opens.
      Bridge.connectorsIntroDone = false
      reply(webView, id, ["state": "ok"])
    case "connectorsIntroSeen":
      // The settings page reports it actually SHOWED the intro — the mark
      // lives there, not at window-open, so a race with the page's first
      // load cannot burn the intro unseen.
      Bridge.connectorsIntroDone = true
      reply(webView, id, ["state": "ok"])
    case "markHandheld":
      // A connector kind that has now been walked through once.
      let kind = String((payload["id"] as? String ?? "").prefix(64))
      if !kind.isEmpty, kind.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) {
        var list = Bridge.handheld
        if !list.contains(kind) { list.append(kind); Bridge.handheld = list }
      }
      reply(webView, id, ["state": "ok"])
    case "prefs":
      reply(webView, id, [
        "state": "ok",
        "motion": Bridge.motionAnyway,
        "sounds": Bridge.soundsOn,
        "onboarded": Bridge.onboarded,
        "scale": Bridge.scale,
        "scaleMin": Bridge.scaleRange.lowerBound,
        "scaleMax": Bridge.scaleRange.upperBound,
        // Whether this process is running from the app's real home. Fresh
        // downloads run from ~/Downloads or a mounted DMG; onboarding's first
        // screen offers the move only when this is false. The env override
        // exists because the dev machine is always installed correctly and
        // the screen would otherwise be untestable.
        "inApplications": ProcessInfo.processInfo.environment["HAZLIE_FAKE_UNINSTALLED"] == "1"
          ? false : Bundle.main.bundlePath.hasPrefix("/Applications/"),
        "connectorsIntroDone": Bridge.connectorsIntroDone,
        "handheld": Bridge.handheld,
      ])
    case "setMotion":
      let on = payload["on"] as? Bool ?? false
      Bridge.motionAnyway = on
      delegate?.motionAnywayChanged(on)
      reply(webView, id, ["state": "ok", "motion": on])
    case "fitContent":
      // A page telling native how tall it actually needs to be. The popups
      // have fixed base sizes, and a fixed size is a guess about content that
      // grows: the connector grid gained a third row and the last one was
      // simply cut off by the window edge.
      //
      // extraWidth (optional) widens the popup past its base — the
      // connections page opens its hint strip as a SIDE section, and the
      // window grows leftward because placedFrame pins the right edge.
      // Same Int/Double dance as setScale: whole JS numbers arrive as Int.
      let h = (payload["height"] as? Double) ?? Double(payload["height"] as? Int ?? 0)
      let ew = (payload["extraWidth"] as? Double) ?? Double(payload["extraWidth"] as? Int ?? -1)
      delegate?.fitPopup(webView, contentHeight: h, extraWidth: ew)
      reply(webView, id, ["state": "ok"])
    case "setScale":
      // Accept Int as well as Double: a JS number that happens to be whole
      // arrives as an NSNumber that bridges to Int, and a slider parked on
      // 1.00 is exactly that case.
      let raw = (payload["value"] as? Double) ?? Double(payload["value"] as? Int ?? 1)
      let v = Bridge.clampScale(raw)
      // A drag applies live but does not persist; the value is written when
      // the thumb is released. Otherwise one pull across the range rewrites
      // UserDefaults forty times to land on the same number.
      let committed = (payload["commit"] as? Bool) ?? true
      if committed { Bridge.scale = v }
      // The sender is passed through so the window that OWNS the slider can be
      // left alone while the slider is being dragged — see scaleChanged.
      delegate?.scaleChanged(v, committed: committed, from: webView)
      reply(webView, id, ["state": "ok", "scale": v])
    case "setSounds":
      let on = payload["on"] as? Bool ?? false
      Bridge.soundsOn = on
      delegate?.soundsChanged(on)
      reply(webView, id, ["state": "ok", "sounds": on])
    case "close":
      delegate?.closeWindow(of: webView)
      reply(webView, id, ["state": "ok"])
    case "drag":
      delegate?.dragWindow(of: webView)
      reply(webView, id, ["state": "ok"])
    case "status":
      fetchStatus { [weak self] data in self?.reply(webView, id, data) }
    case "bridgeStatus":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      bridgeCall("GET", "api/bridge", query: ["p": p]) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeBegin":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      bridgeCall("POST", "api/bridge/begin", json: ["p": p], timeout: 22) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeCookies":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      // The paste is passed through verbatim and deliberately not persisted,
      // logged, or echoed — the server masks it out of transcripts.
      let cookies = payload["cookies"] as? String ?? ""
      bridgeCall("POST", "api/bridge/cookies", json: ["p": p, "cookies": cookies], timeout: 15) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeWebLogin":
      // The mom-friendly path (BridgeLogin.swift): begin the login, open the
      // platform's REAL login page in an isolated in-app webview, harvest the
      // session cookies once the user is in, and hand them to the same cookies
      // endpoint. The webview and its cookies never touch this bridge's own
      // views; only the harvested set is POSTed to the loopback server.
      let p = String((payload["p"] as? String ?? "").prefix(24))
      bridgeCall("POST", "api/bridge/begin", json: ["p": p], timeout: 22) { [weak self] begin in
        guard let self else { return }
        guard begin["state"] as? String == "ok",
              let loginUrl = begin["loginUrl"] as? String,
              let cookieDomain = begin["cookieDomain"] as? String
        else {
          self.reply(webView, id, begin) // begin failed → pass the notice back
          return
        }
        let label = begin["label"] as? String ?? p
        DispatchQueue.main.async {
          BridgeLogin.present(label: label, loginUrl: loginUrl, cookieDomain: cookieDomain) { cookiesJSON in
            guard let cookiesJSON else {
              self.reply(webView, id, ["state": "cancelled"])
              return
            }
            self.bridgeCall(
              "POST", "api/bridge/cookies", json: ["p": p, "cookies": cookiesJSON], timeout: 15
            ) { done in
              self.reply(webView, id, done)
            }
          }
        }
      }
    case "ask":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      // Consume the pending transcript now: this ask either IS the voice
      // turn (same text, both sides trim and cap identically) or superseded
      // it, and a superseded transcript must never claim a later answer.
      let voiceTurn = pendingVoiceUtterance == utterance
      pendingVoiceUtterance = nil
      ask(utterance) { [weak self] data in
        guard let self else { return }
        self.reply(webView, id, data)
        if voiceTurn,
           let text = data["text"] as? String, data["state"] as? String == "ok" {
          self.delegate?.speakAnswer(text)
        }
      }
    case "cancel":
      askTask?.cancel()
      reply(webView, id, ["state": "ok"])
    case "openExternal":
      let urlString = payload["url"] as? String ?? ""
      if allowedExternal.contains(urlString), let url = URL(string: urlString) {
        NSWorkspace.shared.open(url)
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "url not in allowlist"])
      }
    case "openConnectLink":
      // The tokened connect-page URL is dynamic (the token rotates), so it
      // cannot be in the static allowlist. The connect server writes it to
      // ~/.hazlie/connect-link.txt (0600); read it and open it, but ONLY if it
      // is the loopback URL it is supposed to be — never an arbitrary address.
      let linkFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".hazlie/connect-link.txt")
      if let raw = try? String(contentsOf: linkFile, encoding: .utf8),
         let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
         url.scheme == "http",
         url.host == "localhost" || url.host == "127.0.0.1" {
        NSWorkspace.shared.open(url)
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "no connect link yet"])
      }
    // People identity-review (users-b8's Stage 3). Thin hermes passthroughs —
    // same bearer + identity gate as ask(); the body shape belongs to the
    // people server, so we reply whatever it returns verbatim.
    case "initSearch":
      let days = (payload["days"] as? Int) ?? Int(payload["days"] as? Double ?? 365)
      peopleCall("POST", "people/init", json: ["days": days]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleReview":
      let days = (payload["days"] as? Int) ?? Int(payload["days"] as? Double ?? 365)
      let limit = (payload["limit"] as? Int) ?? Int(payload["limit"] as? Double ?? 20)
      peopleCall("GET", "people/review?days=\(days)&limit=\(limit)", json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleDecide":
      let a = String(payload["a"] as? String ?? "")
      let b = String(payload["b"] as? String ?? "")
      let verdict = String(payload["verdict"] as? String ?? "")
      peopleCall("POST", "people/decide", json: ["a": a, "b": b, "verdict": verdict]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleMap":
      // Phase 2 constellation view. days 0/absent = all time. Bigger body
      // (~1MB) than the others; the passthrough's JSON path handles it.
      let days = (payload["days"] as? Int) ?? Int(payload["days"] as? Double ?? 0)
      let path = days > 0 ? "people/map?days=\(days)" : "people/map"
      peopleCall("GET", path, json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }
    default:
      reply(webView, id, ["state": "error", "error": "unknown message type"])
    }
  }

  // Shared passthrough for the /people/* endpoints: bearer + the same exact
  // /health identity check ask() uses, then reply the server's JSON verbatim.
  private func peopleCall(
    _ method: String, _ path: String, json: [String: Any]?,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    checkHermesIdentity { [weak self] identityOK in
      guard let self else { return }
      guard identityOK else { done(["state": "identity"]); return }
      let req = self.request(method, self.hermesBase, path, bearer: tok, json: json, timeout: 30)
      self.session.dataTask(with: req) { data, resp, err in
        guard err == nil, let http = resp as? HTTPURLResponse else {
          done(["state": "down"]); return
        }
        switch http.statusCode {
        case 200:
          if let d = data,
             let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            done(obj)
          } else {
            done(["state": "error", "error": "unparseable"])
          }
        case 401, 403: done(["state": "auth"])
        case 404: done(["state": "notready"])
        default: done(["state": "error", "error": "http \(http.statusCode)"])
        }
      }.resume()
    }
  }

  private func reply(_ webView: WKWebView, _ id: Int, _ data: [String: Any]) {
    let envelope: [String: Any] = ["id": id, "ok": true, "data": data]
    guard JSONSerialization.isValidJSONObject(envelope),
          let json = try? JSONSerialization.data(withJSONObject: envelope),
          let s = String(data: json, encoding: .utf8)
    else { return }
    DispatchQueue.main.async {
      webView.evaluateJavaScript("window.__hzDispatch(\(s))", completionHandler: nil)
    }
  }

  // MARK: auth

  // Re-read per request, matching hermes' own semantics: rotation needs no
  // restart. 0600 on disk; a webview could never read this file — only this
  // native process can, which is the whole reason the bearer channel exists.
  private func bearerToken() -> String? {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/secrets/hermes-token.txt")
    guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    let tok = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let hex = Set("0123456789abcdef")
    guard tok.count == 64, tok.allSatisfy({ hex.contains($0) }) else { return nil }
    return tok
  }

  private func request(
    _ method: String, _ base: URL, _ path: String,
    bearer: String?, json: [String: Any]? = nil, timeout: TimeInterval? = nil
  ) -> URLRequest {
    // The path may carry a query ("people/review?days=365"). It cannot ride
    // appendingPathComponent whole — that percent-encodes the '?', hermes
    // then sees one literal path component and 404s — so split it here and
    // let URLComponents keep '?' a delimiter, the way bridgeCall builds its
    // URLs.
    let url: URL
    if let q = path.firstIndex(of: "?") {
      var comps = URLComponents(
        url: base.appendingPathComponent(String(path[..<q])), resolvingAgainstBaseURL: false)!
      comps.query = String(path[path.index(after: q)...])
      url = comps.url!
    } else {
      url = base.appendingPathComponent(path)
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    if let t = timeout { req.timeoutInterval = t }
    if let b = bearer { req.setValue("Bearer \(b)", forHTTPHeaderField: "Authorization") }
    if let j = json {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: j)
    }
    // No Origin header is ever set — URLSession doesn't add one, and that
    // absence IS the widget's channel: hermes and connect route bearer auth
    // only for Origin-less requests.
    return req
  }

  // MARK: status

  private func fetchStatus(_ done: @escaping ([String: Any]) -> Void) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    let req = request("GET", connectBase, "api/status", bearer: tok, timeout: 5)
    session.dataTask(with: req) { data, resp, err in
      guard err == nil, let http = resp as? HTTPURLResponse else {
        done(["state": "down"]); return
      }
      switch http.statusCode {
      case 200:
        guard let d = data,
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              obj["sources"] is [[String: Any]]
        else { done(["state": "error", "error": "unparseable status"]); return }
        var out = obj
        out["state"] = "ok"
        done(out)
      case 401: done(["state": "auth"])
      case 404: done(["state": "noroute"]) // connect predates /api/status
      default: done(["state": "error", "error": "http \(http.statusCode)"])
      }
    }.resume()
  }

  // MARK: social bridges

  // The bridge-login lane (ops/WIDGET-BRIDGE-LOGIN-SPEC.md): three calls that
  // mirror fetchStatus — same bearer, same Origin-less channel, same loopback
  // base — driving the local bridge bots for Messenger/Instagram. The cookie
  // paste rides this once and is masked server-side out of every transcript;
  // nothing here stores or logs it. begin/cookies wait on a live bot, so they
  // get 15s where status gets 5.
  private func bridgeCall(
    _ method: String, _ path: String, query: [String: String] = [:],
    json: [String: Any]? = nil, timeout: TimeInterval = 5,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    var url = connectBase.appendingPathComponent(path)
    if !query.isEmpty {
      var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
      comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
      url = comps.url!
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = timeout
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    if let j = json {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: j)
    }
    session.dataTask(with: req) { data, resp, err in
      guard err == nil, let http = resp as? HTTPURLResponse else {
        done(["state": "down"]); return
      }
      let body = data.flatMap {
        try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
      }
      switch http.statusCode {
      case 200:
        guard var out = body else { done(["state": "error", "error": "unparseable"]); return }
        out["state"] = "ok"
        done(out)
      case 401: done(["state": "auth"])
      default:
        // Non-200 here is genuinely an error, not the bot disagreeing: a
        // WRONG cookie paste comes back 200 with the bot's complaint in the
        // transcript (the JS renders that). 400 is "you pasted nothing", 502
        // is a Matrix/network fault — both carry {error}. Pass it through.
        var out = body ?? [:]
        out["state"] = "error"
        if out["error"] == nil { out["error"] = "http \(http.statusCode)" }
        done(out)
      }
    }.resume()
  }

  // MARK: chat

  // Identity, then the ask. Port 8787 taught this repo that a listener
  // answering 200 proves nothing; the body must be exactly {"ok":true}.
  private func checkHermesIdentity(_ done: @escaping (Bool) -> Void) {
    let req = request("GET", hermesBase, "health", bearer: nil, timeout: 3)
    session.dataTask(with: req) { data, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
        && data.flatMap { String(data: $0, encoding: .utf8) }?
          .trimmingCharacters(in: .whitespacesAndNewlines) == "{\"ok\":true}"
      done(ok)
    }.resume()
  }

  private func ask(_ utterance: String, _ done: @escaping ([String: Any]) -> Void) {
    guard !utterance.isEmpty else { done(["state": "error", "error": "empty"]); return }
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    checkHermesIdentity { [weak self] identityOK in
      guard let self else { return }
      guard identityOK else { done(["state": "identity"]); return }
      // Body is exactly {"utterance": ...}. The client never sends context
      // snippets — evidence selection is the vault's job, on the other side
      // of the corpus boundary.
      let req = self.request(
        "POST", self.hermesBase, "vault/ask",
        bearer: tok, json: ["utterance": utterance])
      let task = self.session.dataTask(with: req) { data, resp, err in
        if let e = err as NSError?, e.code == NSURLErrorCancelled {
          done(["state": "cancelled"]); return
        }
        guard err == nil, let http = resp as? HTTPURLResponse else {
          done(["state": "down"]); return
        }
        switch http.statusCode {
        case 200:
          guard let d = data,
                let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                let text = obj["text"] as? String
          else { done(["state": "error", "error": "unparseable answer"]); return }
          done(["state": "ok", "text": text, "sources": obj["sources"] as? [String] ?? []])
        case 404: done(["state": "notready"]) // /vault/ask not landed yet
        case 401, 403: done(["state": "auth"])
        default: done(["state": "error", "error": "http \(http.statusCode)"])
        }
      }
      self.askTask = task
      task.resume()
    }
  }
}
