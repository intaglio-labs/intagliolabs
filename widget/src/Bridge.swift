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
  func openMonths()
  func openConnectRoot() -> Bool
  /// The review queue at /c/<token>/memory — the same tokened link, one
  /// path deeper. Separate from openConnectRoot because it is a different
  /// destination, not a different way of reaching the same one.
  func openMemoryReview() -> Bool
  func closeWindow(of webView: WKWebView)
  func dragWindow(of webView: WKWebView)
  func motionAnywayChanged(_ on: Bool)
  func soundsChanged(_ on: Bool)
  func scaleChanged(_ scale: Double, committed: Bool, from webView: WKWebView?)
  func fitPopup(_ webView: WKWebView, contentHeight: Double, extraWidth: Double)
  func widgetSpot() -> [String: Double]
  func widgetBoundsChanged()
  func spotlightWidget(_ on: Bool)
  func openOnboarding()
  func setupProgress(_ payload: [String: Any])
  /// Drop the onboarding scrim below ordinary windows so a system prompt can be
  /// seen, and put it back afterwards.
  func yieldForPrompt(_ yield: Bool)
  // Like yieldForPrompt, but for System Settings rather than a transient
  // dialog: it also pushes the scrim BEHIND, because Settings is a window the
  // owner works in for a while rather than answers and dismisses.
  func yieldForSettings(_ yield: Bool)
}

final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, URLSessionTaskDelegate {

  // WHICH PAGE MAY ASK FOR WHAT.
  //
  // Every webview registers this same Bridge under the same handler name, so
  // until this table existed the dispatch switched on the message type alone and
  // any page could call anything: onboarding could start a bridge login, the
  // connections popup could ask a question, and any of them could post a
  // voiceTranscript for an utterance the microphone never heard.
  //
  // Nothing exploited that -- the pages are local, every one carries a CSP, and
  // the only innerHTML writes escape properly -- so this is a compartment, not a
  // patch. The reason to build it anyway is the blast radius: the day a page does
  // render something untrusted, the answer should be "it could call three things"
  // rather than "it could call everything". The check is cheap because the
  // message already arrives with its webView.
  //
  // Derived from what each page actually calls (grep hzPost across widget/ui);
  // `markHandheld` has no caller today and is listed under connections because
  // that is the surface it is about. A case missing from every list here is a
  // test failure, not a silent 404 -- see widget/test/bridge-capabilities.test.mjs.
  static let sharedActions: Set<String> = [
    // bridge.js is loaded by every page, so these two are everyone's.
    "prefs", "fitContent",
  ]
  static let pageCapabilities: [String: Set<String>] = [
    "widget": ["drag", "openChat", "openChatWith", "openConnections",
               "openMonths", "voiceArm", "widgetBounds"],
    "chat": ["ask", "cancel", "chatReady", "close", "decideClaim"],
    "connections": ["bridgeBegin", "bridgeCookies", "bridgeStatus", "bridgeWebLogin",
                    "close", "connectorsIntroSeen", "openConnectLink", "openMemoryReview", "openExternal",
                    "status", "setConnectorEnabled", "setMotion", "setScale", "setSounds",
                    "openOnboarding", "markHandheld",
                    // Same setup controls, reachable from the gear after the
                    // flow — a skipped step must stay reachable.
                    "setupState", "modelDownload", "modelCancel",
                    "openFullDiskAccess", "startSources",
                      // Google signs in from the tile: mail and calendar are one
                      // account and one grant. Without this grant the button
                      // renders and silently does nothing, which is exactly the
                      // class widget/test/bridge-capabilities.test.mjs catches.
                      "googleAuth",
                   "permissionState", "requestPermission"],
    "onboarding": ["close", "moveToApplications", "onboardingDone", "spotlightWidget",
                   "widgetSpot",
                   // The setup scenes: choosing and fetching the answer model,
                   // and turning on the first data source.
                   "setupState", "modelDownload", "modelCancel",
                    "openFullDiskAccess", "startSources", "openPeople",
                    "permissionState", "requestPermission",
                    // Which scene is up, remembered so a restart resumes on it.
                    "onboardingStep"],
    // people.html includes connector-tile.js as well as people.js (check the
    // script tags, not the file's own comment about being shared), so the People
    // popup renders connector tiles and needs the bridge verbs too. Writing this
    // map from the wrong file cost one broken popup in review.
    "people": ["close", "initSearch", "peopleDecide", "peopleReview", "status",
               "bridgeBegin", "bridgeCookies", "bridgeStatus", "bridgeWebLogin",
               "connectorsIntroSeen", "openExternal", "setConnectorEnabled", "connectSecret", "openApp",
               "openFullDiskAccess"],
    // peopleFind: search across every year, server-ranked. peopleMap: the
    // ALL-YEARS source behind the constellation — every person, uncapped, with
    // their per-year topics. monthsView: where the popup was left, so a restart
    // resumes on it rather than snapping back to this year.
    "people-months": ["close", "peopleYear", "peopleFind", "peopleSummary",
                      "openPeople", "monthsView", "peopleMap", "peopleAvatars"],
    "ear": ["orbState", "voiceError", "voiceTranscript"],
  ]

  // Set by the factories in Windows.swift at creation. ObjectIdentifier rather
  // than the URL: the page's own address is a thing the page influences, and
  // identity here should come from the code that made the view.
  private var pageOf: [ObjectIdentifier: String] = [:]

  func register(_ webView: WKWebView, as page: String) {
    pageOf[ObjectIdentifier(webView)] = page
  }

  private func allows(_ webView: WKWebView, _ type: String) -> Bool {
    if Bridge.sharedActions.contains(type) { return true }
    guard let page = pageOf[ObjectIdentifier(webView)],
          let allowed = Bridge.pageCapabilities[page] else { return false }
    return allowed.contains(type)
  }

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

  // WHICH FLOW SOMEBODY COMPLETED, recorded but NOT used to force a replay.
  //
  // This gate used to read `!onboarded || revision < current`, which replays the
  // whole welcome for every existing install: `onboarded` is true for them and
  // the revision key is absent, and UserDefaults reads a missing integer as 0,
  // so 0 < 2 and the flow runs again on the next launch.
  //
  // Redesigning the flow is not a reason to make somebody sit through it. They
  // have already granted the permissions, chosen a model and downloaded it --
  // the whole point of the welcome -- and a finished setup that reopens itself
  // reads as the app having lost their data, which is the single most alarming
  // thing this app could imply. The gear replays it on demand for anyone who
  // wants to see what changed.
  //
  // The stamp stays because it is worth knowing which flow a person saw, and
  // because a future change that genuinely does need an existing install to
  // revisit something can opt in HERE, deliberately, rather than by the side
  // effect of a version bump.
  static let onboardingRevisionDefaultsKey = "HazlieOnboardingRevision"
  static let currentOnboardingRevision = 2
  static var needsOnboarding: Bool { !onboarded }
  static func completeOnboarding() {
    onboarded = true
    UserDefaults.standard.set(currentOnboardingRevision, forKey: onboardingRevisionDefaultsKey)
  }

  // WHICH SCENE THE FLOW WAS ON, so a restart resumes rather than rewinds.
  //
  // Granting Full Disk Access to a running app makes macOS offer "Quit &
  // Reopen" — and taking it dropped the owner back on the welcome screen, to
  // walk the whole flow again, having just done the hardest step in it. The
  // page reports each scene as it opens; a first-run launch resumes on the
  // last one reported, and finishing clears it.
  // WHERE THE TIMELINE POPUP WAS LEFT: the year, whether the list or the globe
  // was up, and the topic it was filtered to. Remembered for the same reason
  // onboardingStep is — the panel survives hidden with its page state intact,
  // so closing and reopening already returns you where you were, but a RESTART
  // recreates the page and it came back on the current year with nothing
  // selected. Landing somewhere other than where you left reads as the app
  // having thrown your place away.
  //
  // One opaque string, written and parsed by people-months.js. Native does not
  // interpret it: what "where you were" means belongs to the page, and giving
  // this key a schema would mean changing Swift every time the page grows a
  // fourth thing to remember.
  static let monthsViewKey = "HazlieMonthsView"
  static var monthsView: String? {
    get { UserDefaults.standard.string(forKey: monthsViewKey) }
    set {
      if let v = newValue { UserDefaults.standard.set(v, forKey: monthsViewKey) }
      else { UserDefaults.standard.removeObject(forKey: monthsViewKey) }
    }
  }

  static let stepDefaultsKey = "HazlieOnboardingStep"
  static var onboardingStep: String? {
    get { UserDefaults.standard.string(forKey: stepDefaultsKey) }
    set {
      if let v = newValue { UserDefaults.standard.set(v, forKey: stepDefaultsKey) }
      else { UserDefaults.standard.removeObject(forKey: stepDefaultsKey) }
    }
  }

  // Interface sounds. Unlike Reduce Motion there is no system setting to
  // inherit, so this defaults ON — and an absent key has to be checked for
  // explicitly, because UserDefaults reads a missing Bool as false and would
  // otherwise ship every fresh install silent.
  // See case "widgetBounds": CSS-px offset of the visible widget's left edge
  // within its window. nil until the page first reports.
  static var widgetVisibleLeftCSS: Double? = nil

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
  private let hermesBase = URL(string: "http://127.0.0.1:51789")!
  private let connectBase: URL = {
    // Dev override for the port ONLY — the host is not configurable. Lets a
    // second connect instance (e.g. --port 8790 from a worktree) serve the
    // widget without touching the launchd one.
    var port = 51788
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
  // The transcript (not typed text) still waiting for its ask, matched by
  // TEXT: the ear page posts the transcript and the chat page posts the ask
  // with no shared id between them, so identical text (both sides trim and
  // cap the same way) is the only join. Lifecycle: set on voiceTranscript,
  // consumed by the ask that matches it, and cleared by the next TYPED
  // message (openChatWith) — typing supersedes a spoken turn, so a
  // transcript the busy chat page silently dropped can never claim a later
  // identical typed ask. A non-matching ask leaves it alone, because the
  // transcript may still be queued behind that ask (load-time messages are
  // delivered one ask at a time).
  private var pendingVoiceUtterance: String?

  // Only desktop applications named by the connector UI may be launched.
  private let allowedApps: Set<String> = ["com.granola.app"]

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
    // Telegram's app registration — each install gets its own api_id/api_hash.
    //
    // RESTORED IN THE MERGE (2026-08-26). This entry and the walkthrough that
    // sends the owner to it were both present at 72b5960 and both absent by
    // 91e8285, and 72b5960 is an ancestor of it — so they were lost, not never
    // written. The loss is in `0f17d26` "Merge updated connector onboarding
    // branch": its two parents were 2e58f17 (no walkthrough) and 72b5960 (two),
    // and it resolved widget/ui/connections.js and this file toward the side
    // that had neither.
    //
    // ~~"lost when the People-tab PR (9176ef8) reverted these files".~~ WRONG,
    // and corrected here rather than left standing: 9176ef8 is innocent, its
    // connections.js diff is +17/-10 and touches neither. A reviewer traced it
    // properly and I had blamed the wrong commit. Worth the correction because
    // the true cause is a different KIND of bug — not a PR overwriting a file,
    // but a merge silently choosing the older side — and `git log -S` will not
    // find it, because it skips merge commits by default. That is exactly where
    // a loss like this hides.
    //
    // None of it was ever on main; it is branch work. connectors/test/
    // openExternal.test.mjs is what caught the survivor half — the walkthrough
    // came through the merge, its allowlist entry did not, and the symptom
    // would have been a link that does nothing.
    "https://my.telegram.org/apps",
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
    // Fail closed: an unregistered view, or a page asking for something outside
    // its compartment, gets an error rather than the action.
    guard allows(webView, type) else {
      let page = pageOf[ObjectIdentifier(webView)] ?? "unregistered"
      dbg("REFUSED \(type) from \(page)")
      reply(webView, id, ["state": "error", "error": "action not available to this surface"])
      return
    }
    let payload = body["payload"] as? [String: Any] ?? [:]

    switch type {
    case "openChat":
      delegate?.openChat()
      reply(webView, id, ["state": "ok"])
    case "openChatWith":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      if !utterance.isEmpty {
        // A typed message supersedes any voice turn still waiting: without
        // this, a transcript the busy chat page dropped would linger and
        // could claim a later typed ask with the same words for the speaker.
        pendingVoiceUtterance = nil
        delegate?.openChat(with: utterance)
      }
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
      // because a single boolean could not tell "Intaglio Labs is speaking" from
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
    case "openMonths":
      delegate?.openMonths()
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
      Bridge.completeOnboarding()
      // Nothing left to resume; a replay from settings starts at the welcome.
      Bridge.onboardingStep = nil
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
        "onboarded": !Bridge.needsOnboarding,
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
    case "widgetBounds":
      // Where the VISIBLE widget starts inside its mostly-transparent window,
      // in CSS px from the window's left edge. The widget window is 312pt wide
      // but the orb cluster is right-aligned inside it, so a panel placed
      // against the WINDOW edge floats ~160pt away from anything visible —
      // the side panels place against this instead.
      if let left = payload["left"] as? Double, left.isFinite, left >= 0,
         abs((Bridge.widgetVisibleLeftCSS ?? -1000) - left) > 0.5 {
        Bridge.widgetVisibleLeftCSS = left
        delegate?.widgetBoundsChanged()
      }
      reply(webView, id, ["state": "ok"])
    case "status":
      fetchStatus { [weak self] data in self?.reply(webView, id, data) }
    case "setConnectorEnabled":
      // This webview-controlled write is deliberately limited to the passive
      // WhatsApp connector marker; no arbitrary path reaches the filesystem.
      let connector = payload["connector"] as? String ?? ""
      guard connector == "whatsapp" else {
        reply(webView, id, ["state": "error", "error": "unknown connector"])
        return
      }
      let marker = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".hazlie/connectors/\(connector).disabled")
      do {
        if payload["enabled"] as? Bool == true {
          if FileManager.default.fileExists(atPath: marker.path) { try FileManager.default.removeItem(at: marker) }
        } else {
          try Data().write(to: marker, options: .atomic)
          try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
        }
        Connectors.shared.start()
        reply(webView, id, ["state": "ok"])
      } catch {
        reply(webView, id, ["state": "error", "error": "could not update connector"])
      }
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
    case "googleAuth":
      // START THE GOOGLE SIGN-IN FROM THE TILE, with no terminal in the way.
      // The connect service spawns ops/gcal-auth.mjs, which opens Google in the
      // default browser and listens on its own loopback port for the callback.
      // Nothing sensitive crosses this bridge: the request carries only which
      // of two fixed flows to run, and the grant is written by that helper
      // straight into ~/.hazlie/secrets.
      let gf = String(payload["flow"] as? String ?? "google")
      // Which OAuth client signs this account in. The connect service checks
      // the name against its registry, so an unknown one is a 400 rather than
      // an argument reaching the helper's command line.
      let gc = String(payload["client"] as? String ?? "default")
      bridgeCall("POST", "api/google-auth", json: ["flow": gf, "client": gc], timeout: 15) { [weak self] d in
        guard let self else { return }
        // The service started the helper and handed back the URL to show. The
        // consent screen opens HERE rather than in the default browser, which
        // is what every other login in this app already does — see
        // GoogleLogin.swift for why that window is a viewport and not a
        // participant in the grant.
        if let url = (d as? [String: Any])?["url"] as? String, !url.isEmpty {
          DispatchQueue.main.async {
            GoogleLogin.present(url: url) { ok, why in
              // `ok` says the window saw Google redirect to the loopback
              // callback, which is the helper taking the code — not that the
              // tokens are written. The shelf re-reads status either way,
              // because the file on disk is the only thing that actually
              // settles it.
              //
              // `why` is set when Google REFUSED rather than the owner closing
              // the window: an account outside the org, a declined consent, an
              // admin policy. That distinction is worth carrying — "you picked
              // the wrong account" and "you changed your mind" look identical
              // from here otherwise, and only one of them is fixable by trying
              // again the same way.
              var out: [String: Any] = ["ok": ok, "opened": true]
              if let why { out["refused"] = why }
              self.reply(webView, id, out)
            }
          }
        } else {
          self.reply(webView, id, d)
        }
      }
    case "connectSecret":
      let p = String(payload["p"] as? String ?? "")
      let value = String(payload["value"] as? String ?? "")
      bridgeCall("POST", "api/secret", json: ["p": p, "value": value], timeout: 10) { [weak self] d in
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
      // Fetch policy without beginning the Matrix-bot conversation. Beginning
      // used to happen first, which meant a fresh install with no bridge state
      // failed before the real Facebook/Instagram/X login window could even
      // appear. The login window needs only the static, server-authored policy;
      // start the bot immediately after cookies are available.
      bridgeCall("GET", "api/bridge", query: ["p": p]) { [weak self] begin in
        guard let self else { return }
        guard begin["state"] as? String == "ok",
              let loginUrl = begin["loginUrl"] as? String,
              let cookieDomain = begin["cookieDomain"] as? String
        else {
          self.reply(webView, id, begin) // begin failed → pass the notice back
          return
        }
        // The web-login policy comes from the server's platform table. A
        // platform with no host list cannot be linked this way at all — Discord
        // and Slack want a pasted token, Telegram a phone code — so say so and
        // let the page offer the manual path, instead of opening a window whose
        // first navigation the fence would cancel and whose cookie poll could
        // never fire. That blank window was the bug.
        let allowedHosts = (begin["allowedHosts"] as? [String])?.filter { !$0.isEmpty } ?? []
        let sessionCookie = begin["sessionCookie"] as? String ?? ""
        let requiredCookies = (begin["requiredCookies"] as? [String])?.filter { !$0.isEmpty } ?? []
        let cookieFormat = begin["cookieFormat"] as? String ?? "json"
        // The bridge's field contract, flattened to strings — the login window
        // fills it in without interpreting any of it.
        let fields: [[String: String]] = (begin["fields"] as? [[String: Any]] ?? []).map { f in
          var out: [String: String] = [:]
          for (k, v) in f { if let sv = v as? String { out[k] = sv } }
          return out
        }
        // A window needs a fence and SOMETHING to wait for. ~~That was read as
        // "a session cookie", which is only one of the two shapes~~ — Slack's
        // window harvests no session at all: it exists so the person can
        // answer the CAPTCHA Slack demands before it will email a code, and it
        // waits on the `fields` contract instead. Requiring a cookie here
        // meant Slack replied "manual" and no window ever opened, which is
        // exactly what the card kept showing (owner, 2026-08-26).
        let approval = begin["approval"] as? Bool ?? false
        let userAgent = String((begin["userAgent"] as? String ?? "").prefix(300))
        // Subframe-only hosts: a challenge widget's iframes. Same server-authored
        // shape as allowedHosts, enforced separately — see BridgeLogin's fence.
        let allowedFrameHosts = (begin["allowedFrameHosts"] as? [String])?.filter { !$0.isEmpty } ?? []
        // Where a storage field's value lives, when signing in does not land
        // there. Server-authored like the rest; the window uses it at most once.
        let storageUrl = String((begin["storageUrl"] as? String ?? "").prefix(300))
        let label = begin["label"] as? String ?? p
        // A QR LOGIN IS ALSO A WINDOW, just not a webview one. Discord has no
        // login page to drive — its bridge posts a remote-auth QR and waits
        // for the phone app — so it takes this branch before the webview
        // guard below, which would send it to the card's manual path.
        if begin["qrLogin"] as? Bool == true {
          self.presentQrLogin(webView, id: id, p: p, label: label)
          return
        }
        guard !allowedHosts.isEmpty, !sessionCookie.isEmpty || !fields.isEmpty || approval else {
          // No window for this platform — Telegram signs in by phone number
          // and a code, which is a conversation, not a page. The card runs it.
          //
          // ~~This branch ran `begin` itself, so one press opened on the bot's
          // first question~~ (d88e56c). Withdrawn the same day: `begin` sends
          // cancel-then-login, so a press on a tile whose login was ALREADY in
          // flight destroyed it — and each press put six command messages into
          // a sixteen-message transcript window, which scrolled the owner's own
          // answer out of sight and left the card unable to see that anything
          // had happened (owner, 2026-08-26: "i'm stuck here").
          //
          // The card begins the login instead, and it can do so safely because
          // it is the side that already parses whether the bot is mid-question.
          // One press still reaches the question; deciding here could not tell
          // "nothing started" from "something is waiting for an answer".
          self.reply(webView, id, ["state": "manual", "transcript": begin["transcript"] ?? []])
          return
        }
        DispatchQueue.main.async {
          BridgeLogin.present(
            label: label, loginUrl: loginUrl, cookieDomain: cookieDomain,
            sessionCookie: sessionCookie, allowedHosts: allowedHosts,
            requiredCookies: requiredCookies, cookieFormat: cookieFormat,
            fields: fields, approval: approval, userAgent: userAgent,
            allowedFrameHosts: allowedFrameHosts, storageUrl: storageUrl
          ) { cookiesJSON in
            guard let cookiesJSON else {
              self.reply(webView, id, ["state": "cancelled"])
              return
            }
            // BEGIN FIRST, EXCEPT WHEN THE LOGIN IS ALREADY UNDERWAY. A cookie
            // harvest is self-contained: the window collects the session and
            // the conversation starts afterwards, which is why begin lives
            // here rather than before the window (a fresh install with no
            // bridge state used to fail before the window could appear).
            //
            // A CHALLENGE window is the opposite. It opens partway through a
            // conversation the bot is already holding — Slack asked for the
            // challenge because it had been given an email address — and
            // begin's first act is `cancel`. Calling it here would throw away
            // the very request whose answer this window just captured, and the
            // bot would then be asked for an email address with a captcha
            // token. Derived from the field contract, like the rest.
            let midConversation = fields.contains { $0["from"] == "captcha" }
            let sendValue = {
              self.bridgeCall(
                "POST", "api/bridge/cookies", json: ["p": p, "cookies": cookiesJSON], timeout: 15
              ) { done in
                self.reply(webView, id, done)
              }
            }
            if midConversation {
              sendValue()
            } else {
              self.bridgeCall("POST", "api/bridge/begin", json: ["p": p], timeout: 22) { started in
                guard started["state"] as? String == "ok" else {
                  self.reply(webView, id, started)
                  return
                }
                sendValue()
              }
            }
          }
        }
      }
    // ---- setup: what onboarding needs to know and do ----------------------
    case "setupState":
      // Everything the setup scenes render from, in one round trip. Deliberately
      // says what IS rather than what SHOULD BE: the model tier is read off the
      // symlink, voice from the presence of the tree the ear actually loads, and
      // "is any data flowing" from hermes' own row count rather than from a
      // permission check. macOS gives no honest answer about Full Disk Access
      // from this process anyway — FDA attributes per resolved binary, and the
      // binary that matters is the node launchd spawns, not this app. The rows
      // are the probe, the same way each connector's run() is its own probe.
      let voiceDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".hazlie/models/voice/models")
      var state: [String: Any] = [
        "state": "ok",
        "voice": FileManager.default.fileExists(atPath: voiceDir.path),
        "downloading": ModelSetup.isDownloading,
        "recommended": ModelSetup.recommended,
        // nodePath was here and is deliberately gone. No page ever read it, and a
        // payload that carries the path to a unix binary is one render away from
        // putting "node" in front of somebody again — which is the whole thing this
        // app spent a day removing. The daemon is a child of the app; the app is what
        // holds the grants and the app is what the UI names.
        "tiers": ModelSetup.tiers.map { t in
          ["id": t.id, "label": t.label, "detail": t.detail, "bytes": t.bytes]
        },
      ]
      state["model"] = ModelSetup.installed?.id ?? ""
      rows { n, memory in
        var out = state
        out["rows"] = n
        if let memory { out["memory"] = memory }
        self.reply(webView, id, out)
      }

    case "modelDownload":
      let tier = String((payload["tier"] as? String ?? "").prefix(8))
      ModelSetup.download(
        tierId: tier,
        progress: { [weak self] got, total in
          self?.delegate?.setupProgress([
            "phase": "downloading", "got": got, "total": total, "tier": tier,
          ])
        },
        done: { [weak self] failure in
          guard let self else { return }
          if let failure {
            self.delegate?.setupProgress(["phase": "failed", "error": failure, "tier": tier])
            if failure != "cancelled" {
              ModelSetup.notify(title: "Setup didn’t finish", body: failure)
            }
            return
          }
          // The weights exist now, so the agent that needs them can. Installed
          // here rather than at next launch, because "downloaded but you must
          // restart the app" is not finished.
          self.delegate?.setupProgress(["phase": "installing", "tier": tier])
          DispatchQueue.global(qos: .utility).async {
            // THE RUNTIME BEFORE THE AGENT. provision() no-ops on an
            // already-set-up machine, so a binary the bundle gained later never
            // came out -- and installing an agent that points at a missing
            // binary just parks it at exit 78 while this screen waits forever.
            guard Provision.ensureLlamaRuntime() else {
              self.delegate?.setupProgress([
                "phase": "failed", "tier": tier,
                "error": "the model is saved, but the engine that runs it is missing",
              ])
              return
            }
            Provision.installAgent("io.intaglio.llama-server")
            Provision.kickstart("io.intaglio.llama-server")
            // hermes holds the llama base URL open; restart it so the first ask
            // after setup does not meet a proxy pointed at nothing.
            Provision.kickstart("io.intaglio.hermes")
            // REACH AN ENDING. Loading several GB of weights takes a while, so
            // wait -- but bounded, and then say which way it went. A screen that
            // says "checking" forever is the one state that is never true.
            if Provision.waitForLlama() {
              self.delegate?.setupProgress(["phase": "ready", "tier": tier])
              ModelSetup.notify(
                title: "Intaglio Labs can answer now",
                body: "The model finished downloading and is ready.")
            } else {
              let why = "The model is saved but didn’t start. Reopen the app to try again."
              self.delegate?.setupProgress([
                "phase": "failed", "tier": tier, "error": why,
              ])
              ModelSetup.notify(title: "Setup didn’t finish", body: why)
            }
          }
        }
      )
      reply(webView, id, ["state": "ok"])

    case "modelCancel":
      ModelSetup.cancel()
      reply(webView, id, ["state": "ok"])

    case "onboardingStep":
      // Fire-and-forget from showScreen(). Bounded because it is a UserDefaults
      // key written from a webview message, and an unbounded string there is a
      // disk write the page controls the size of.
      if let step = payload["step"] as? String, step.count <= 16 {
        Bridge.onboardingStep = step
      }
      reply(webView, id, ["state": "ok"])

    case "openFullDiskAccess":
      // Touch a protected path FIRST, then open the pane. macOS lists an app
      // under Full Disk Access once it has attempted a protected read, so the
      // failed attempt is what puts "intaglio labs" in the list with a switch
      // already waiting. Without it the owner has to press +, walk a file
      // picker to Applications, and find the app themselves — which is the
      // copy-paste problem wearing different clothes.
      // Get the scrim out of the way FIRST. It is full-screen at .floating, so
      // System Settings — an ordinary level-0 window — came up UNDERNEATH it:
      // "opens in the background with no way to get to it", and the step got
      // skipped, and Messages and Notes then read nothing.
      delegate?.yieldForSettings(true)
      Permissions.primeFullDisk()
      // And the part Settings will not do: the app, on screen, draggable onto
      // the list. See FullDiskHelper.
      FullDiskHelper.shared.begin { [weak self] in
        self?.delegate?.yieldForSettings(false)
      }
      reply(webView, id, ["state": "ok"])

    case "startSources":
      // Write the connectors config if it is not there, then (re)start the
      // daemon. There is no list of sources to choose: the daemon runs every
      // connector it has credentials for and each one's needs() gates it, so
      // the local Apple stores turn on together the moment Full Disk Access
      // lands. The config is what makes the daemon boot AT ALL -- without it
      // the agent parks at exit 1 -- so writing it is the whole action.
      let ok = writeConnectorsConfigIfMissing()
      // Started as a CHILD of this app, not bootstrapped into launchd, so the
      // reader inherits this app's permissions instead of needing its own.
      Provision.retireConnectorsAgent()
      Connectors.shared.start()
      Distiller.shared.start()
      reply(webView, id, ["state": ok ? "ok" : "error"])

    case "permissionState":
      Permissions.writeDiagnostic()
      reply(webView, id, ["state": "ok", "permissions": Permissions.all])

    case "requestPermission":
      // A real system prompt, in context, naming this app. macOS shows it once
      // per app per permission and remembers a refusal, so a second press does
      // nothing — the page reads the returned status and offers Settings when
      // it comes back denied.
      let which = String((payload["which"] as? String ?? "").prefix(16))
      // The scrim is full-screen and above ordinary windows; a TCC prompt is an
      // ordinary window. Drop out of its way, or it opens underneath and the
      // owner refuses something they never saw.
      delegate?.yieldForPrompt(true)
      Permissions.request(which) { [weak self] status in
        guard let self else { return }
        self.delegate?.yieldForPrompt(false)
        // Granted mid-flow means the reader can suddenly see more; nudge it so
        // the owner does not wait for the next poll to see anything happen.
        if status == .granted { Connectors.shared.start() }
        self.reply(webView, id, ["state": "ok", "which": which, "status": status.rawValue])
      }

    case "ask":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      // The voice turn is the ask carrying the transcript's exact text.
      // Consume it only on a match: a non-matching ask may be a load-time
      // message queued AHEAD of the transcript, whose own ask is still
      // coming — clearing here would silence it. Typed messages clear the
      // transcript at openChatWith instead.
      let voiceTurn = pendingVoiceUtterance == utterance
      if voiceTurn { pendingVoiceUtterance = nil }
      ask(utterance) { [weak self] data in
        guard let self else { return }
        // AN ABSTENTION IS NOT ALWAYS THE SAME ANSWER.
        //
        // "nothing in what i've got covers that" means one thing when the memory
        // has read everything and quite another while it is still reading — and
        // the second is the case somebody hits right after connecting, when the
        // app looks broken rather than busy. So a sourceless answer carries the
        // reading state with it and the page can say which one this is.
        //
        // Attached HERE rather than in hermes' answer, whose shape is exactly
        // {text, sources, usedRows} and is pinned by a contract test. Costs a
        // loopback GET, and only when the answer came back empty-handed.
        //
        // TWO REPLY PATHS, so everything that has to happen once per settled ask
        // happens on both of them: speaking a voice turn, and handing the page
        // the next queued message. Neither may sit after this closure's last
        // statement — the guard below returns, and the enrichment path replies
        // from a nested callback long after that line would have run.
        let sourceless = (data["sources"] as? [Any])?.isEmpty ?? true
        guard sourceless, data["state"] as? String == "ok" else {
          self.reply(webView, id, data)
          self.speakIfVoiceTurn(data, voiceTurn: voiceTurn)
          self.deliverNextQueued(to: webView)
          return
        }
        // Two questions on an empty answer, and they are different questions:
        // /stats says whether the memory is still READING, and suggest says whether
        // something already read would have answered this if anyone had confirmed
        // it. The second is the one worth acting on, so it wins when both are true.
        self.rows { _, memory in
          self.suggestion(for: utterance) { claim in
            var out = data
            if let memory { out["memory"] = memory }
            if let claim { out["confirm"] = claim }
            self.reply(webView, id, out)
            self.speakIfVoiceTurn(out, voiceTurn: voiceTurn)
            // This ask settled; if a load-time message is queued behind it,
            // hand the page the next one as its OWN ask. After the reply, never
            // before it: reply()'s evaluateJavaScript is what resolves the ask's
            // promise and drops chat.js's busy flag, and a message handed over
            // while that flag is still set is dropped on the floor.
            self.deliverNextQueued(to: webView)
          }
        }
      }
    case "decideClaim":
      // Accept or reject ONE claim, from the chat bubble that raised it. The
      // owner is the actor on the record either way — nothing here decides
      // anything on its own, it only carries a press to hermes.
      let claimId = payload["id"] as? Int ?? -1
      let action = String((payload["action"] as? String ?? "").prefix(8))
      guard claimId > 0, action == "accept" || action == "reject" else {
        reply(webView, id, ["state": "error", "error": "bad decision"])
        break
      }
      guard let tok = bearerToken() else {
        reply(webView, id, ["state": "error", "error": "no token"])
        break
      }
      let dreq = request("POST", hermesBase, "admin/memory/decide", bearer: tok,
                         json: ["claim_id": claimId, "action": action], timeout: 6)
      URLSession.shared.dataTask(with: dreq) { [weak self] _, response, _ in
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        DispatchQueue.main.async {
          self?.reply(webView, id, ["state": ok ? "ok" : "error"])
        }
      }.resume()
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
    case "openApp":
      let bundleId = String((payload["bundleId"] as? String ?? "").prefix(96))
      guard allowedApps.contains(bundleId),
            let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
      else {
        reply(webView, id, ["state": "notInstalled"])
        return
      }
      let config = NSWorkspace.OpenConfiguration()
      config.activates = true
      NSWorkspace.shared.openApplication(at: appURL, configuration: config) { [weak self] _, error in
        DispatchQueue.main.async {
          self?.reply(webView, id, error == nil ? ["state": "ok"] : ["state": "notInstalled"])
        }
      }
    case "openMemoryReview":
      // What the app has learned about its owner, and the place to correct it.
      // The page and its server never went anywhere; the route in from the app
      // did, when the memory card was retired.
      if delegate?.openMemoryReview() == true {
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "no connect link yet"])
      }
    case "openConnectLink":
      // The cloud-connector setup door: the connect page's ROOT, in the
      // browser — a full setup flow (tokens, app passwords) that wants a real
      // browser.
      if delegate?.openConnectRoot() == true {
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "no connect link yet"])
      }
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
    case "peopleYear":
      // The timeline view: one year of people with the year's topics. Absent
      // year = server default (the current year).
      let year = (payload["year"] as? Int) ?? Int(payload["year"] as? Double ?? 0)
      // A refresh the reader asked for: the server rebuilds before answering.
      let wantsRebuild = payload["rebuild"] as? Bool == true
      let yBase = year > 0 ? "people/year?year=\(year)" : "people/year?"
      let yPath = wantsRebuild ? yBase + "&rebuild=1" : yBase
      peopleCall("GET", yPath, json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleFind":
      // Search across every year, ranked by hermes. The page used to filter the
      // open year's already-loaded list, which could not reach a person in
      // another year or past the 250 that list holds.
      let fq = String(String(payload["q"] as? String ?? "").prefix(100))
      let esc = fq.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
      peopleCall("GET", "people/find?q=\(esc)", json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }

    case "peopleMap":
      // Every person across every year, with per-year topics and NO row cap —
      // which is why the constellation reads from here rather than summing the
      // year payloads: those are capped per year, and a sum of capped pages
      // would print topic counts that are quietly short.
      peopleCall("GET", "people/map?for=page" + ((payload["rebuild"] as? Bool == true) ? "&rebuild=1" : ""), json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }

    case "monthsView":
      // Both directions on one verb: a payload with "state" saves, a bare call
      // reads. Bounded for the same reason onboardingStep is — this is a
      // UserDefaults write driven by a webview message, and an unbounded string
      // there is a disk write whose size the page chooses.
      if let s = payload["state"] as? String {
        Bridge.monthsView = s.count <= 120 ? s : nil
      }
      reply(webView, id, ["state": Bridge.monthsView ?? ""])

    case "peopleAvatars":
      let keys = (payload["keys"] as? [String])?.prefix(400).map { String($0.prefix(200)) } ?? []
      peopleCall("POST", "people/avatars", json: ["keys": Array(keys)]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleSummary":
      // Model-written year summary for one person; generated on demand,
      // served by hermes from the LOCAL model only.
      let sKey = String(payload["key"] as? String ?? "")
      let sYear = (payload["year"] as? Int) ?? Int(payload["year"] as? Double ?? 0)
      peopleCall("POST", "people/summary", json: ["key": sKey, "year": sYear]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    default:
      reply(webView, id, ["state": "error", "error": "unknown message type"])
    }
  }

  // Shared passthrough for the /people/* endpoints: bearer + the same exact
  // /health identity check ask() uses, then reply the server's JSON verbatim.
  /// HERMES IS COMING UP, NOT BROKEN.
  ///
  /// widget/build.sh restarts hermes and this app together, so the app's very
  /// first request routinely lands before hermes is listening. Both the identity
  /// probe and the request itself then fail on connection refused, and both were
  /// terminal — the page rendered "couldn't load 2026" on essentially every first
  /// launch, which is what the owner reported seeing "every time".
  ///
  /// Retried with a backoff, and ONLY for the two states that mean "not up yet".
  /// An auth failure, a 404 or an HTTP error are answers, not silence, and
  /// retrying them would turn a clear message into a slow one.
  private static let transientStates: Set<String> = ["down", "identity"]
  /// Sized against the thing that actually blocks: hermes is single-threaded, and
  /// a cold /people/year is 5.7 seconds of SYNCHRONOUS work on this corpus. While
  /// that runs the process cannot answer anything at all — so a second request's
  /// identity probe times out and reports "identity", meaning "not the hermes I
  /// trust", when the truth is "busy". Every panel open fires several calls, so
  /// this was not a rare race; it was the common case.
  ///
  /// The budget therefore has to outlast a cold build plus queueing, not just a
  /// process launch (which is only 270ms). ~37s, and it costs nothing at all when
  /// hermes is warm because the first attempt succeeds.
  private static let retryDelays: [Double] = [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0]

  private func peopleCall(
    _ method: String, _ path: String, json: [String: Any]?,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    peopleCallAttempt(method, path, json: json, attempt: 0, done)
  }

  private func peopleCallAttempt(
    _ method: String, _ path: String, json: [String: Any]?,
    attempt: Int, _ done: @escaping ([String: Any]) -> Void
  ) {
    peopleCallOnce(method, path, json: json) { [weak self] result in
      let state = result["state"] as? String
      guard let self,
            let state, Bridge.transientStates.contains(state),
            attempt < Bridge.retryDelays.count
      else { done(result); return }
      // Only the transient pair reaches here, so this cannot mask a real answer.
      DispatchQueue.main.asyncAfter(deadline: .now() + Bridge.retryDelays[attempt]) {
        self.peopleCallAttempt(method, path, json: json, attempt: attempt + 1, done)
      }
    }
  }

  private func peopleCallOnce(
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

  // MARK: setup helpers

  /// Speak the answer if this turn began with the voice. Pulled out of the ask
  /// handler when that grew a second reply path: the two must not be able to
  /// disagree about whether the turn was spoken.
  ///
  /// The provenance is PASSED IN, not read from a stored flag. A process-global
  /// "a voice turn is pending" latch belongs to whichever ask settles next, and
  /// that is not necessarily the transcript's own: chat.js drops incoming
  /// messages while busy, so a transcript spoken during a typed composition is
  /// discarded and the latch stays armed until the TYPED question's answer
  /// arrives -- which then gets read aloud. Carrying the flag with the utterance
  /// (matched at the ask, see pendingVoiceUtterance) is what makes speaking
  /// impossible on any turn but the spoken one.
  private func speakIfVoiceTurn(_ data: [String: Any], voiceTurn: Bool) {
    guard voiceTurn else { return }
    guard let text = data["text"] as? String, data["state"] as? String == "ok" else { return }
    delegate?.speakAnswer(text)
  }

  /// The proposed claim that would have answered this question, if any.
  ///
  /// Only ever called when the answer came back with no sources, so it costs a
  /// loopback GET on exactly the turns that had nothing to show anyway. Failure
  /// is silent by design: a suggestion that does not arrive leaves an ordinary
  /// abstention, which is what the turn already was.
  private func suggestion(for question: String, done: @escaping ([String: Any]?) -> Void) {
    guard let tok = bearerToken(), !question.isEmpty,
          // A query string, so URLComponents rather than the request() helper:
          // that appends a PATH component and would escape the "?" into the path.
          var comps = URLComponents(url: hermesBase.appendingPathComponent("admin/memory/suggest"),
                                    resolvingAgainstBaseURL: false) else { done(nil); return }
    comps.queryItems = [
      URLQueryItem(name: "q", value: question),
      URLQueryItem(name: "limit", value: "1"),
    ]
    guard let url = comps.url else { done(nil); return }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 4
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: req) { data, _, _ in
      var first: [String: Any]?
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let claims = obj["claims"] as? [[String: Any]] {
        first = claims.first
      }
      DispatchQueue.main.async { done(first) }
    }.resume()
  }

  /// hermes' own row count, or 0 when it cannot be reached. Used as the honest
  /// answer to "is any of my data actually in here yet" -- a number that only
  /// moves when a connector really read something and really wrote it.
  /// Row count AND how far the memory is through reading them.
  ///
  /// The count alone was misleading in the way that mattered: rows arrive fast,
  /// and the app still cannot answer until those rows are DISTILLED into claims.
  /// Reporting only "found 18,440 things" while every question abstained is what
  /// produced "it has full access and knows nothing". /stats carries both numbers
  /// now; this passes the second one through untouched.
  private func rows(_ done: @escaping (Int, [String: Any]?) -> Void) {
    guard let tok = bearerToken() else { done(0, nil); return }
    let req = request("GET", hermesBase, "stats", bearer: tok, timeout: 4)
    URLSession.shared.dataTask(with: req) { data, _, _ in
      var n = 0
      var memory: [String: Any]?
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        n = obj["rows"] as? Int ?? 0
        memory = obj["memory"] as? [String: Any]
      }
      DispatchQueue.main.async { done(n, memory) }
    }.resume()
  }

  /// The connectors daemon refuses to start without ~/.hazlie/connectors/config.json
  /// and says so; on a fresh install nothing writes it, so the agent parks at
  /// exit 1 forever and no data ever arrives. This writes the minimum valid one.
  ///
  /// Deliberately almost empty. There is no "enabled sources" list to fill in --
  /// every install runs every connector it has credentials for, and each source's
  /// needs() decides whether it can run this pass. So the file's job here is to
  /// exist and to parse; every key in it is an override nobody has asked for yet.
  ///
  /// Held to the same file standard as a secret (0600 inside the 0700 tree),
  /// because daemon.mjs checks: it is the file whose silent replacement would
  /// redirect what gets polled.
  @discardableResult
  private func writeConnectorsConfigIfMissing() -> Bool {
    let fm = FileManager.default
    let dir = fm.homeDirectoryForCurrentUser.appendingPathComponent(".hazlie/connectors")
    let file = dir.appendingPathComponent("config.json")
    if fm.fileExists(atPath: file.path) { return true }
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
      try "{}\n".write(to: file, atomically: true, encoding: .utf8)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      return true
    } catch {
      return false
    }
  }

  // Messages that arrived before chat.js finished loading queue one by one
  // (main.swift). chatReady hands the page the first; each settled ask pulls
  // the next through __hzIncoming, so every queued message becomes its own
  // ask. The page is idle by then: reply()'s evaluateJavaScript resolved the
  // ask's promise, whose continuation drops chat.js's busy flag before this
  // later evaluateJavaScript runs.
  private func deliverNextQueued(to webView: WKWebView) {
    DispatchQueue.main.async { [weak self] in
      guard let self,
            let next = self.delegate?.takePendingUtterance(), !next.isEmpty,
            let json = try? JSONSerialization.data(withJSONObject: [next]),
            let arr = String(data: json, encoding: .utf8)
      else { return }
      webView.evaluateJavaScript(
        "window.__hzIncoming && window.__hzIncoming(\(arr)[0])", completionHandler: nil)
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
  /// Discord's login, end to end: open the window on the press, ask the bot
  /// for a QR, show it, and poll the bridge until the phone approves it.
  ///
  /// THE WINDOW OPENS FIRST. `login` is a round trip to a bot in a container
  /// (3.8s measured here), and doing that before showing anything is what made
  /// the tile look dead on the first press — the owner pressed twice and read
  /// the second press as the one that worked. Instagram's window is up
  /// immediately because its policy is static; this one now opens on the same
  /// press and fills in when the code lands.
  ///
  /// The QR is the bridge's own Matrix media, inlined as a data: URI by the
  /// connect server (lib/bridge.mjs inlineMedia, images only and capped) —
  /// this process fetches nothing to show it.
  ///
  /// WHAT COMES BACK to the page is deliberately not the transcript. A
  /// finished attempt's QR is redacted by the bridge, so replaying the
  /// conversation into the card is how the card ended up showing the words
  /// around a code that was no longer there; the card gets a fresh status
  /// instead, or `cancelled`, which is the state its begin button already
  /// knows how to answer.
  private func presentQrLogin(_ webView: WKWebView, id: Int, p: String, label: String) {
    // A bot reply with no image — "You're already logged in", or a bridge that
    // is down — is the card's to show, not this window's. Captured here so the
    // close path can hand it back.
    var fallback: [String: Any]?
    // ENDING TAKES TWO POLLS IN A ROW. The bot posts "Error logging in:
    // websocket: close sent" for a socket that lapsed, and on this machine
    // that line was followed by "Successfully logged in" from the scan the
    // owner had just done — so a window that closed on the first sighting
    // would have closed a login that was about to succeed.
    var endingStreak = 0
    // Main thread: this is reached from a URLSession completion, and it puts a
    // window on screen.
    DispatchQueue.main.async {
      BridgeLogin.presentQR(
        label: label,
        // Owner's wording (2026-08-26). Not "the Discord app": a phone camera
        // recognises the code and offers the app itself, and naming a second
        // piece of software to go and open first is a step that is not there.
        instruction: "scan this with your phone camera",
        fetch: { [weak self] deliver in
          guard let self else { deliver(nil); return }
          self.bridgeCall("POST", "api/bridge/begin", json: ["p": p], timeout: 22) { begun in
            guard begun["state"] as? String == "ok" else {
              fallback = begun
              deliver(nil)
              return
            }
            // The LAST bot image: a retried login posts a second code, and the
            // stale one is still above it in the transcript.
            let transcript = begun["transcript"] as? [[String: Any]] ?? []
            let qr = transcript.reversed().first { m in
              (m["from"] as? String) == "bot"
                && (m["image"] as? String)?.hasPrefix("data:image/") == true
            }?["image"] as? String
            if qr == nil {
              fallback = ["state": "manual", "transcript": begun["transcript"] ?? []]
            }
            deliver(qr)
          }
        },
        check: { [weak self] report in
          guard let self else { return }
          self.bridgeCall("GET", "api/bridge", query: ["p": p]) { st in
            if st["connected"] as? Bool == true { report(.connected); return }
            // The bridge says it is over in words, and they are the bot's own.
            // Matching the shape rather than the sentence, because that string
            // is the container's to change.
            let lines = (st["transcript"] as? [[String: Any]] ?? [])
              .compactMap { ($0["from"] as? String) == "bot" ? $0["body"] as? String : nil }
            let last = lines.last?.lowercased() ?? ""
            let over = last.contains("error logging in") || last.contains("websocket")
              || last.contains("timed out") || last.contains("cancelled")
            endingStreak = over ? endingStreak + 1 : 0
            report(endingStreak >= 2 ? .ended : .waiting)
          }
        }
      ) { [weak self] result in
        guard let self else { return }
        guard result != nil else {
          self.reply(webView, id, fallback ?? ["state": "cancelled"])
          return
        }
        // Linked. Re-read rather than reporting the poll's own copy, so the card
        // paints from the same source every other path uses.
        self.bridgeCall("GET", "api/bridge", query: ["p": p]) { done in
          self.reply(webView, id, done)
        }
      }
    }
  }

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
    // 12s, not 3. This probe asks "is this the hermes I trust", and the honest
    // answer while it is mid-compute is "wait" -- but a 3s timeout turned a busy
    // process into a failed identity check, which the caller could not tell from
    // a hostile one. hermes answers /health in 270ms when it is free, so a long
    // ceiling only ever costs time in the case that used to fail outright.
    let req = request("GET", hermesBase, "health", bearer: nil, timeout: 12)
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
