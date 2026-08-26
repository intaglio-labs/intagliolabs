// The Beeper-style in-app login for the social bridges. Instagram (and Messenger,
// unless you want a password) can only be linked with session cookies, and the
// mom-friendly way to get them — the way Beeper does it — is to open the
// platform's REAL login page in an embedded webview, let the owner log in
// normally, and read the session cookies straight out of that webview. No
// devtools, no copy-paste.
//
// SECURITY POSTURE — this is the one place the app touches the live web, so it is
// fenced hard and separately from everything else (reviewed with the widget owner):
//
//  * A DEDICATED navigation delegate (LoginNavDelegate), never the shared Bridge
//    delegate. The Bridge delegate refuses every non-file: URL and guards the
//    chat/settings/onboarding webviews; loosening it would un-fence those. This
//    login view gets its own delegate so that fence is untouched.
//  * That delegate is SCOPED to the platform's own login hosts and cancels
//    navigation to anything else, so a redirect chain cannot wander off it.
//    The host list and the session-cookie name arrive from the connect server's
//    platform table (connect/lib/bridge.mjs) rather than being hardcoded here.
//    They used to be hardcoded -- to Meta's four hosts and to `c_user` -- while
//    that table advertised a login for six platforms, so X, Discord, Slack and
//    Telegram got a blank window and a cookie poll that could never fire. The
//    fence is still ENFORCED here; it is no longer AUTHORED here.
//  * A NON-PERSISTENT data store, isolated from the app, discarded on teardown.
//  * Torn down on success, cancel, AND window close — never left resident.
//
// The harvested cookies go only to the loopback connect server
// (/api/bridge/cookies, bearer); they never touch a third party or disk.

import AppKit
import WebKit

final class BridgeLogin: NSObject, WKNavigationDelegate, NSWindowDelegate {
  // Held for the life of the window so ARC doesn't reclaim it mid-login.
  private static var current: BridgeLogin?

  private let label: String
  private let cookieDomain: String
  private let sessionCookie: String
  // Every cookie that must exist before the harvest may fire. Defaults to just
  // the session cookie; X needs [auth_token, ct0] because ct0 (its CSRF token)
  // lands on X's own schedule and a harvest triggered by auth_token alone
  // could snapshot before it existed ("Missing some keys: [ct0]").
  private let requiredCookies: [String]
  private let allowedSuffixes: [String]
  private let done: (String?) -> Void

  private var window: NSWindow?
  private var web: WKWebView?
  private var poll: Timer?
  private var finished = false
  // The green underscore blinks like a terminal cursor.
  private var headerTitle: NSTextField?
  private var blink: Timer?
  private var cursorOn = true

  private init(
    label: String, cookieDomain: String, sessionCookie: String, allowedHosts: [String],
    requiredCookies: [String], done: @escaping (String?) -> Void
  ) {
    self.label = label
    self.cookieDomain = cookieDomain
    // Which cookie means "logged in", per the platform table. Harvest is the
    // whole domain regardless; this is only the signal to know the user is in.
    self.sessionCookie = sessionCookie
    self.requiredCookies = requiredCookies.isEmpty ? [sessionCookie] : requiredCookies
    self.allowedSuffixes = allowedHosts
    self.done = done
  }

  // Present the login window. `done(json)` fires once with the cookie JSON on
  // success, or `done(nil)` on cancel/close. Main thread.
  //
  // REFUSES TO OPEN rather than opening something it cannot finish. Three ways
  // that happens, and each of them used to produce a blank branded window:
  // an unparseable URL, an empty host list (a platform whose bridge takes a
  // token or a phone code, not cookies), or a login URL whose own host is not in
  // the list. The last is not paranoia -- loginUrlFrom() prefers a "Login URL:"
  // line out of the bridge bot's transcript, which is content from a container,
  // so the URL is checked against the policy before it is ever loaded.
  static func present(
    label: String, loginUrl: String, cookieDomain: String,
    sessionCookie: String, allowedHosts: [String], requiredCookies: [String] = [],
    done: @escaping (String?) -> Void
  ) {
    guard let url = URL(string: loginUrl), let host = url.host, !allowedHosts.isEmpty,
          !sessionCookie.isEmpty,
          allowedHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) })
    else { done(nil); return }
    // Only one login window at a time; a second request supersedes the first.
    current?.finish(nil)
    let ctl = BridgeLogin(
      label: label, cookieDomain: cookieDomain,
      sessionCookie: sessionCookie, allowedHosts: allowedHosts,
      requiredCookies: requiredCookies, done: done
    )
    current = ctl
    ctl.show(url: url)
  }

  private func show(url: URL) {
    let W: CGFloat = 480, webH: CGFloat = 680, headH: CGFloat = 62
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent() // isolated + discarded on teardown
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: webH), configuration: config)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self // OUR delegate, never Bridge's
    self.web = web

    // Hazlie chrome above the real login page. A login window is the most
    // impersonation-shaped surface this app has, so the FRAME must read as
    // Hazlie (terminal palette, mono) — a fake with default system chrome then
    // stands out. It also names the real domain, so the owner can see they're on
    // the genuine site, and states plainly that Hazlie never sees the password.
    let content = NSView(frame: NSRect(x: 0, y: 0, width: W, height: webH + headH))
    content.wantsLayer = true
    web.frame = NSRect(x: 0, y: 0, width: W, height: webH)
    let header = makeHeader(width: W, height: headH)
    header.frame = NSRect(x: 0, y: webH, width: W, height: headH)
    header.autoresizingMask = [.width, .minYMargin]
    content.addSubview(web)
    content.addSubview(header)

    let win = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: W, height: webH + headH),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered, defer: false
    )
    win.title = "" // brand lives in the header as the green underscore, not here
    win.level = .normal // a real window, above the desktop-level widget
    win.isReleasedWhenClosed = false
    win.delegate = self
    win.contentView = content
    win.center()
    self.window = win

    NSApp.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)

    // A real Safari user-agent. WKWebView's default UA carries no Safari
    // marketing token, and the big login SPAs — x.com most visibly — serve a
    // blank page to it (the owner saw an empty white window on X). A stock
    // desktop-Safari string makes them render their normal login flow.
    web.customUserAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    web.load(URLRequest(url: url))

    // Poll the webview's own cookie store for the session cookie. When it
    // appears with a value, the user is logged in — harvest and finish.
    let timer = Timer(timeInterval: 1.2, repeats: true) { [weak self] _ in
      self?.checkCookies()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.poll = timer
  }

  // The terminal-palette, mono header. Values mirror the connect page's
  // "Terminal Palette v0.2" so Hazlie's login window is visually of a piece with
  // the rest of the app.
  private func makeHeader(width: CGFloat, height: CGFloat) -> NSView {
    func color(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
      NSColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }
    let bg = color(0x14, 0x14, 0x12)
    let muted = color(0x8a, 0x8a, 0x8a)
    let mono = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    let view = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
    view.wantsLayer = true
    view.layer?.backgroundColor = bg.cgColor

    func makeLabel(_ text: String, font: NSFont, color c: NSColor, y: CGFloat) -> NSTextField {
      let t = NSTextField(labelWithString: text)
      t.font = font
      t.textColor = c
      t.backgroundColor = .clear
      t.isBordered = false
      t.frame = NSRect(x: 16, y: y, width: width - 32, height: font.pointSize + 6)
      t.autoresizingMask = [.width]
      return t
    }

    // The brand mark is the GREEN UNDERSCORE (as on the landing page), not the
    // company name — and it BLINKS like a terminal cursor. See titleAttr/startBlink.
    let title = NSTextField(labelWithAttributedString: titleAttr(cursorOn: true))
    title.backgroundColor = .clear
    title.isBordered = false
    title.frame = NSRect(x: 16, y: height - 30, width: width - 32, height: 19)
    title.autoresizingMask = [.width]
    headerTitle = title
    startBlink()
    // State the trust fact plainly.
    let sub = makeLabel(
      "your credentials stay local",
      font: mono, color: muted, y: 8
    )
    view.addSubview(title)
    view.addSubview(sub)
    return view
  }

  // The header title: a green "_" (alpha 0 when the cursor is "off") + the
  // connect label. Rebuilt each blink so only the underscore flickers.
  private func titleAttr(cursorOn: Bool) -> NSAttributedString {
    let green = NSColor(red: 0x33 / 255, green: 0xff / 255, blue: 0x66 / 255, alpha: cursorOn ? 1 : 0)
    let hazelnut = NSColor(red: 0xc5 / 255, green: 0xa5 / 255, blue: 0x6d / 255, alpha: 1)
    let boldMono = NSFont(name: "Menlo Bold", size: 13) ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold)
    let s = NSMutableAttributedString()
    s.append(NSAttributedString(string: "_", attributes: [.foregroundColor: green, .font: boldMono]))
    s.append(NSAttributedString(string: "  connect \(label)", attributes: [.foregroundColor: hazelnut, .font: boldMono]))
    return s
  }

  // Blink the cursor ~530ms on/off, the classic terminal cadence.
  private func startBlink() {
    let t = Timer(timeInterval: 0.53, repeats: true) { [weak self] _ in
      guard let self, let field = self.headerTitle else { return }
      self.cursorOn.toggle()
      field.attributedStringValue = self.titleAttr(cursorOn: self.cursorOn)
    }
    RunLoop.main.add(t, forMode: .common)
    blink = t
  }

  private func checkCookies() {
    guard let store = web?.configuration.websiteDataStore.httpCookieStore else { return }
    store.getAllCookies { [weak self] cookies in
      guard let self, !self.finished else { return }
      let mine = cookies.filter { self.domainMatches($0.domain) }
      // ALL required cookies, not just the session signal — the poll simply
      // keeps waiting until the platform has set every one.
      let have = Set(mine.filter { !$0.value.isEmpty }.map { $0.name })
      guard self.requiredCookies.allSatisfy({ have.contains($0) }) else { return }
      var bag: [String: String] = [:]
      for c in mine { bag[c.name] = c.value }
      guard let data = try? JSONSerialization.data(withJSONObject: bag),
            let json = String(data: data, encoding: .utf8) else { return }
      self.finish(json)
    }
  }

  private func domainMatches(_ d: String) -> Bool {
    let host = d.hasPrefix(".") ? String(d.dropFirst()) : d
    return host == cookieDomain || host.hasSuffix("." + cookieDomain)
  }

  // Navigation fence: only the platform's own login hosts, and only https/about.
  // Everything else is cancelled so the login flow cannot be redirected off the
  // platform.
  //
  // HTTPS ONLY. This delegate used to admit `http` as well, on the one webview in
  // this app where a person types a password. It was never reachable -- Info.plist
  // carries no NSAppTransportSecurity key, so default ATS refuses cleartext to a
  // public host regardless of what this returns -- which is exactly why it is
  // gone: dead permissiveness on a credential surface becomes live the day someone
  // adds an unrelated ATS exception. The loopback bases do not come through here.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    if url.scheme == "about" { decisionHandler(.allow); return }
    guard url.scheme == "https", let host = url.host else {
      decisionHandler(.cancel); return
    }
    let ok = allowedSuffixes.contains { host == $0 || host.hasSuffix("." + $0) }
    decisionHandler(ok ? .allow : .cancel)
  }

  /// Is a bridge login on screen right now? The dismiss monitor asks.
  ///
  /// ~~Was isPresenting(window), matching the click's window against this
  /// one.~~ Widened to the whole flow (owner, 2026-08-25, still losing the
  /// panel): window identity only covers clicks the monitor can attribute to
  /// THIS window, and a login is not one window — X bounces through its own
  /// popups and sheets, and the global monitor sees a nil window for anything
  /// outside the app. The panel behind the login is where the result lands,
  /// so nothing may dismiss it while a login is running.
  static var isActive: Bool { current != nil }

  // The user closed the window before logging in.
  func windowWillClose(_ notification: Notification) {
    if !finished { finish(nil) }
  }

  // Single exit for every path: report once, stop polling, drop the webview and
  // its (non-persistent) data store, close the window, release self.
  private func finish(_ result: String?) {
    if finished { return }
    finished = true
    poll?.invalidate(); poll = nil
    blink?.invalidate(); blink = nil
    headerTitle = nil
    let cb = done
    let win = window
    web?.navigationDelegate = nil
    web = nil
    window?.delegate = nil
    window = nil
    if BridgeLogin.current === self { BridgeLogin.current = nil }
    DispatchQueue.main.async {
      win?.close()
      cb(result)
    }
  }
}
