// The Google sign-in window: Google's own consent screen, inside the app.
//
// WHY NOT BridgeLogin.swift, WHICH ALREADY OPENS LOGIN WINDOWS. That class is
// built around HARVESTING — it polls the cookie store and finishes when a
// session cookie (or a named set of fields) appears. OAuth finishes on a
// REDIRECT instead: Google sends the browser to http://127.0.0.1:<port>/callback
// with a one-time code, and ops/gcal-auth.mjs — which is already listening on
// that port and holds the PKCE verifier — exchanges it. Nothing is harvested
// from this window at all. Bending a cookie-poller into a redirect-watcher
// would have put two unrelated finish conditions in one file; this is a
// separate, smaller thing that happens to look the same to the owner.
//
// SO THIS WINDOW IS A VIEWPORT, NOT A PARTICIPANT. It never sees the code (the
// loopback listener does), never touches the tokens (the helper writes them
// 0600), and holds no credential of its own. If it is closed early nothing is
// corrupted — the helper simply times out after its 15 minutes.
//
// NON-PERSISTENT DATA STORE, deliberately: the sign-in must not leave a Google
// session inside the app, and the next authorization must start from a clean
// chooser rather than silently reusing whoever signed in last. That matters
// here more than usual, because adding a SECOND mailbox means signing in as a
// different account — a remembered session would quietly re-grant the first.

import AppKit
import WebKit

final class GoogleLogin: NSObject, WKNavigationDelegate, NSWindowDelegate {
  private static var current: GoogleLogin?

  private var window: NSWindow?
  private var web: WKWebView?
  private var finished = false
  private var reason: String?
  private let done: (Bool, String?) -> Void

  // Google's sign-in walks through several of its own hosts, and a consent
  // screen that cannot reach them is a dead window. The loopback host is the
  // finish line rather than a destination — see decidePolicyFor.
  private static let allowed = [
    "accounts.google.com", "accounts.youtube.com", "myaccount.google.com",
    "google.com", "gstatic.com", "googleusercontent.com", "googleapis.com",
  ]

  private init(done: @escaping (Bool, String?) -> Void) { self.done = done }

  static func present(url: String, done: @escaping (Bool, String?) -> Void) {
    guard let u = URL(string: url), let host = u.host,
          host == "accounts.google.com" else { done(false, nil); return }
    current?.finish(false)
    let ctl = GoogleLogin(done: done)
    current = ctl
    ctl.show(url: u)
  }

  private func show(url: URL) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    let w = WKWebView(frame: NSRect(x: 0, y: 0, width: 520, height: 640), configuration: cfg)
    w.navigationDelegate = self
    // Google refuses its sign-in to user agents it reads as an embedded
    // webview ("this browser or app may not be secure"), which is the whole
    // reason a naive in-app OAuth window fails. Presenting as the Safari on
    // THIS Mac rather than a hardcoded string: a frozen version string ages
    // into the same refusal, which is a bug the bridge login already hit once.
    w.customUserAgent = Self.safariUserAgent()
    web = w

    let win = NSWindow(
      contentRect: w.frame,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false
    )
    win.title = "Sign in to Google"
    win.contentView = w
    win.delegate = self
    win.center()
    win.isReleasedWhenClosed = false
    window = win
    NSApp.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)
    w.load(URLRequest(url: url))
  }

  private static func safariUserAgent() -> String {
    // WebKit's own default, with the app's product token dropped — that token
    // is what marks it as an embedded view.
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let os = "\(v.majorVersion)_\(max(v.minorVersion, 0))"
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X \(os)) AppleWebKit/605.1.15 " +
           "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
  }

  // GOOGLE'S REFUSALS DO NOT REDIRECT, which is why they have to be read off
  // the page. A consent screen that succeeds sends the browser to the loopback
  // callback and the helper takes it from there; a consent screen that REFUSES
  // just renders an error and stops. Nothing arrives at the listener, so the
  // helper waits its full fifteen minutes and this window sits on a dead page
  // — which is exactly what the owner hit signing in with an account outside
  // the org (2026-08-26), three times, each one leaving a stranded process.
  //
  // Read from the URL rather than the rendered text: Google puts the reason in
  // the query string, and matching visible prose would break in every language
  // but this one.
  private static func refusal(in url: URL) -> String? {
    guard let host = url.host, host == "accounts.google.com" else { return nil }
    let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "error" })?.value
    switch q {
    case "org_internal":
      return "That account is outside this organization. This sign-in only accepts "
           + "accounts in the Workspace the app was registered to."
    case "access_denied":
      return "Sign-in was declined."
    case "admin_policy_enforced":
      return "A Workspace admin policy blocks this app for that account."
    case .some(let other):
      return "Google refused the sign-in (\(other))."
    case .none:
      return nil
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url, let host = url.host else {
      decisionHandler(.cancel); return
    }
    // THE FINISH LINE. Google redirecting to the loopback callback means the
    // code has been handed to the helper's listener, which is what actually
    // completes the grant. Cancel the navigation — this window has no business
    // loading it, and the helper answers that request itself — and close.
    if host == "127.0.0.1" || host == "localhost" {
      decisionHandler(.cancel)
      finish(true)
      return
    }
    // A refusal ends the window as surely as a success does — the difference
    // is only what the owner is told. Letting it render and waiting would leave
    // them reading Google's page with nothing here acting on it.
    if let why = Self.refusal(in: url) {
      decisionHandler(.allow) // let them SEE Google's own words too
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
        self?.refused(why)
      }
      return
    }
    let ok = Self.allowed.contains { host == $0 || host.hasSuffix("." + $0) }
    // A fenced window, like the bridge logins: a consent screen that wanders
    // off to an arbitrary host is either a mistake or something worse, and
    // there is nothing on the far side of it this flow needs.
    decisionHandler(ok ? .allow : .cancel)
  }

  func windowWillClose(_ notification: Notification) { finish(false) }

  private func refused(_ why: String) {
    guard !finished else { return }
    reason = why
    finish(false)
  }

  private func finish(_ ok: Bool) {
    guard !finished else { return }
    finished = true
    let w = window
    window = nil
    web = nil
    if Self.current === self { Self.current = nil }
    w?.delegate = nil
    w?.close()
    done(ok, reason)
  }
}
