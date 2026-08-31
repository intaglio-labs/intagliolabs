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

final class BridgeLogin: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate,
                         WKScriptMessageHandler, NSTextFieldDelegate {
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
  /// How the bridge wants the harvested cookies: "header" for a raw Cookie
  /// string, anything else for a JSON object keyed by cookie name. Server
  /// authored (lib/bridge.mjs webLogin.cookieFormat) — enforced here, never
  /// decided here, the same rule allowedHosts follows.
  private let cookieFormat: String
  /// The bridge's full field contract, when it wants more than a cookie jar:
  /// [{id, from: "cookies"|"header", header}]. Server authored — this window
  /// fills it in and never interprets it. Empty for the platforms whose login
  /// really is only cookies.
  private let fields: [[String: String]]
  /// Request headers seen on the live page, by lowercased name. LinkedIn's
  /// X-LI-Track and X-LI-Page-Instance are set by its own JavaScript on XHRs,
  /// so they exist nowhere else — not in the cookie jar, not on a navigation.
  private var seenHeaders: [String: String] = [:]
  /// An APPROVAL window: nothing to harvest and nothing to wait for. Discord's
  /// remote-auth link is approved on Discord's own page, and the bridge learns
  /// the outcome itself — so this window's whole job is to show the page, and
  /// closing it is the end of its part.
  private let approval: Bool
  /// Where a STORAGE field's value actually lives, when signing in does not
  /// land there. Empty for platforms that need no such nudge.
  private let storageUrl: String
  /// Driven there at most once, so a page that simply has no token cannot put
  /// the window in a navigation loop.
  private var nudged = false

  /// A browser string this platform insists on, or empty for the default.
  private let userAgent: String

  /// The browser string this window presents when the policy names none.
  ///
  /// READ FROM THE SYSTEM, NEVER WRITTEN DOWN. ~~A literal "Version/17.4".~~
  /// A user-agent that names a version is a dated assertion, and this one has
  /// now expired into a user-visible bug twice: first as WKWebView's own
  /// default (no Safari token at all, which served the owner a blank window on
  /// x.com), then as a hardcoded 17.4, which by 2026-08 was old enough that
  /// Slack served it the "your browser is not supported" page and cost this
  /// app its entire Slack email login. Measured that day, straight off
  /// slack.com/signin's own boot_data:
  ///
  ///     Version/17.4  is_deprecated_webclient_browser: true   (gate shown)
  ///     Version/18.5  is_deprecated_webclient_browser: true   (gate shown)
  ///     Chrome/126    is_deprecated_webclient_browser: true   (gate shown)
  ///     Version/26.0  flag absent, 64 KB page, no gate
  ///     Version/27.0  flag absent, 64 KB page, no gate
  ///
  /// Bumping the literal would reproduce the same bug with a longer fuse, so
  /// the version comes from the Safari that is actually installed — this app
  /// IS WebKit, so that string is a true statement about the engine rendering
  /// the page, not a costume. It reaches no network and cannot go stale: the
  /// system updates Safari and this follows.
  ///
  /// The fallback only runs if that read fails, which on macOS means Safari
  /// has been removed from /Applications. It is deliberately a floor rather
  /// than a guess at "current", and it WILL rot — if you are reading this
  /// because something serves you an upgrade page, the fix is not to bump it,
  /// it is to find out why the read failed.
  private static let systemSafariUserAgent: String = {
    let version = (Bundle(path: "/Applications/Safari.app")?
      .infoDictionary?["CFBundleShortVersionString"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    // Digits and dots only. A malformed plist value would otherwise be spliced
    // straight into a header, and a UA with a newline in it is a request
    // nobody can debug.
    let ok = !version.isEmpty
      && version.range(of: "^[0-9]+(\\.[0-9]+)*$", options: .regularExpression) != nil
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/"
      + (ok ? version : "18.0") + " Safari/605.1.15"
  }()
  private let allowedSuffixes: [String]
  /// Hosts allowed in SUBFRAMES only — a challenge widget's iframes. Never the
  /// main frame: see the fence for why the two lists are not one.
  private let allowedFrameSuffixes: [String]
  /// Whether a persistently refused page may offer the external connect page.
  /// False for Messenger: a browser has a different cookie jar and cannot
  /// complete the app's automatic session handoff.
  private let allowsBrowserHandoff: Bool
  private let done: (String?) -> Void

  /// Cookie logins normally finish as soon as their cookie payload is ready.
  /// X is the exception: its bridge asks for a local four-digit encrypted-DM
  /// passcode after accepting those cookies. Keeping that continuation here
  /// lets the same trusted window transition from x.com to the local passcode
  /// step instead of closing and making the person find a second Settings card.
  typealias HarvestContinuation = (String, BridgeLogin) -> Void
  private let afterHarvest: HarvestContinuation?
  private var harvestStarted = false

  enum PasscodeOutcome {
    case connected
    case retry(String)
  }
  typealias PasscodeSubmit = (String, @escaping (PasscodeOutcome) -> Void) -> Void
  private var passcodeSubmit: PasscodeSubmit?
  private var passcodeField: NSSecureTextField?
  private var passcodeButton: NSButton?
  private var passcodeError: NSTextField?
  private var passcodeIdleTitle = "continue"

  /// A QR WINDOW's two pieces: the image the bridge posted, and the closure
  /// that asks the bridge whether the scan has landed yet. Both nil for an
  /// ordinary web login — the two modes share this window's chrome and its
  /// single-exit teardown, and nothing else.
  private var qrCheck: ((@escaping (QRProgress) -> Void) -> Void)?
  private var qrFetch: ((@escaping (String?) -> Void) -> Void)?
  private var qrView: NSImageView?
  private var qrSpinner: NSProgressIndicator?
  private var qrHow: NSTextField?
  private var qrRetry: NSButton?
  private var qrExpiry: Date?
  private var qrNextCheck = Date.distantFuture

  private var window: NSWindow?
  private var web: WKWebView?
  // Retain this window's ephemeral store for the life of the login. It is never
  // the process-wide default store, so closing the window drops the web session
  // without touching any other webview in the app.
  private var websiteDataStore: WKWebsiteDataStore?
  private var poll: Timer?
  private var finished = false
  // The green underscore blinks like a terminal cursor.
  private var headerTitle: NSTextField?
  private let windowWidth: CGFloat
  /// The third terminal outcome, beside a cookie jar and nil.
  ///
  /// Chosen so it is neither valid JSON nor a valid Cookie header: Bridge.swift
  /// POSTs any non-nil result straight to /api/bridge/cookies, so a sentinel that
  /// could be mistaken for a credential blob would be relayed into the bridge
  /// bot's transcript. Both call sites guard on it before that POST.
  static let browserHandoff = "__hz_browser_handoff__"

  /// One refusal per window, ever, and one evaluation per navigation.
  private var refusalShown = false
  private var refusalArmed = false
  private var blink: Timer?
  private var cursorOn = true

  private init(
    label: String, cookieDomain: String, sessionCookie: String, allowedHosts: [String],
    requiredCookies: [String], cookieFormat: String, fields: [[String: String]],
    approval: Bool, userAgent: String, allowedFrameHosts: [String],
    browserHandoff: Bool,
    storageUrl: String, windowWidth: Int,
    afterHarvest: HarvestContinuation?,
    done: @escaping (String?) -> Void
  ) {
    self.label = label
    self.cookieDomain = cookieDomain
    // Which cookie means "logged in", per the platform table. Harvest is the
    // whole domain regardless; this is only the signal to know the user is in.
    self.sessionCookie = sessionCookie
    self.requiredCookies = requiredCookies.isEmpty ? [sessionCookie] : requiredCookies
    self.cookieFormat = cookieFormat
    self.fields = fields
    self.approval = approval
    self.userAgent = userAgent
    self.allowedFrameSuffixes = allowedFrameHosts
    self.allowsBrowserHandoff = browserHandoff
    self.storageUrl = storageUrl
    self.allowedSuffixes = allowedHosts
    // WIDE ENOUGH FOR THE PAGE THIS PLATFORM ACTUALLY SERVES.
    //
    // Facebook's login page declares no viewport meta and overflows 480pt --
    // scrollWidth 515 against clientWidth 480, which is the horizontal scrollbar
    // that was reported. 1000 removes it.
    //
    // ~~"so WebKit lays it out at the desktop default and a 480pt window showed
    // the top-left corner of a ~980px page, with the form off-screen"~~ was the
    // reasoning when this landed and it is WRONG. That fallback viewport is iOS
    // WKWebView behaviour; macOS lays out at the view's width. Measured:
    // clientWidth === 480, email field at {x:67,y:271,w:346,h:38}, fully visible,
    // and a replica of this configuration renders the whole form at 480 and at
    // 1000 alike. So this fixed a real 35px overflow and did NOT fix the blank
    // window, which remains open. The retraction stays in the file because the
    // claim already survived one review.
    //
    // Server-authored like the rest of this policy; 0 means "use the default".
    self.windowWidth = windowWidth > 0 ? CGFloat(windowWidth) : 480
    self.afterHarvest = afterHarvest
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
    cookieFormat: String = "json", fields: [[String: String]] = [],
    approval: Bool = false, userAgent: String = "", allowedFrameHosts: [String] = [],
    browserHandoff: Bool = true,
    storageUrl: String = "", windowWidth: Int = 0,
    afterHarvest: HarvestContinuation? = nil,
    done: @escaping (String?) -> Void
  ) {
    // A window must have something to wait for: a session cookie to appear, or
    // the fields a bridge named. Slack's has only fields — it is there so the
    // person can answer a CAPTCHA, and harvests no session at all.
    guard let url = URL(string: loginUrl), let host = url.host, !allowedHosts.isEmpty,
          !sessionCookie.isEmpty || !fields.isEmpty || approval,
          allowedHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) })
    else { done(nil); return }
    // Only one login window at a time; a second request supersedes the first.
    current?.finish(nil)
    let ctl = BridgeLogin(
      label: label, cookieDomain: cookieDomain,
      sessionCookie: sessionCookie, allowedHosts: allowedHosts,
      requiredCookies: requiredCookies, cookieFormat: cookieFormat,
      fields: fields, approval: approval, userAgent: userAgent,
      allowedFrameHosts: allowedFrameHosts, browserHandoff: browserHandoff,
      storageUrl: storageUrl,
      windowWidth: windowWidth, afterHarvest: afterHarvest, done: done
    )
    current = ctl
    ctl.show(url: url)
  }

  /// Resume an X login whose cookie step already finished in an earlier app
  /// session. A tile press still opens the native continuation immediately;
  /// the person never has to open a connector card just to find the passcode
  /// field. New logins reach the same method by transitioning their web window
  /// in place after cookie harvest.
  static func presentPasscode(
    label: String, question: String,
    submit: @escaping PasscodeSubmit,
    done: @escaping (String?) -> Void
  ) {
    current?.finish(nil)
    let ctl = BridgeLogin(
      label: label, cookieDomain: "", sessionCookie: "", allowedHosts: [],
      requiredCookies: [], cookieFormat: "json", fields: [],
      approval: false, userAgent: "", allowedFrameHosts: [], browserHandoff: true,
      storageUrl: "",
      // The passcode window renders its own body and loads no platform page,
      // so 0 keeps the default. This call site carries NO conflict marker --
      // presentPasscode is new on main and never saw the windowWidth parameter,
      // so git had nothing to flag and the file simply stopped compiling.
      windowWidth: 0, afterHarvest: nil, done: done
    )
    current = ctl
    ctl.showPasscode(question: question, submit: submit)
  }

  /// What the bridge has to say about a QR login in flight.
  enum QRProgress {
    case waiting     // the code is up and nobody has scanned it yet
    case connected   // the bridge linked the account; close and report
    case ended       // the attempt is over (expired, cancelled, refused)
  }

  /// A QR LOGIN WINDOW. Discord's bridge does not have a login page to drive:
  /// it posts a remote-auth QR and waits for the Discord phone app to approve
  /// it. So this window loads nothing, fences nothing, and harvests nothing —
  /// it shows the image the bridge sent and asks the bridge, on a timer,
  /// whether the scan landed.
  ///
  /// It is a WINDOW rather than a card in the settings panel because the owner
  /// asked for one (2026-08-26, "a separate pop-up like how instagram login
  /// is"), and because a QR is a thing you point a camera at: on the card it
  /// was 168px standing over the settings it was launched from.
  ///
  /// IT OPENS BEFORE IT HAS A CODE, and that is the point. Asking the bridge
  /// for one means sending `login` and waiting on a bot in a container, which
  /// can take several seconds. A tile that sits there after a press reads as a
  /// tile that did not register the press
  /// (owner, 2026-08-26: "when i first tap discord icon nothing happens").
  /// Instagram's window is immediate because its policy is static; this one
  /// opens on the same press and fills in.
  ///
  /// `fetch` hands back a data: URI the connect server built from the bridge's
  /// own Matrix media — no URL is fetched here — or nil, which closes the
  /// window rather than leaving an empty frame up.
  static func presentQR(
    label: String, instruction: String,
    fetch: @escaping (@escaping (String?) -> Void) -> Void,
    check: @escaping (@escaping (QRProgress) -> Void) -> Void,
    done: @escaping (String?) -> Void
  ) {
    current?.finish(nil) // one login window at a time, whichever kind
    let ctl = BridgeLogin(
      label: label, cookieDomain: "", sessionCookie: "", allowedHosts: [],
      requiredCookies: [], cookieFormat: "json", fields: [],
      approval: false, userAgent: "", allowedFrameHosts: [], browserHandoff: true,
      storageUrl: "",
      // The QR window sizes itself in showQR and never loads a platform page.
      windowWidth: 0, afterHarvest: nil, done: done
    )
    ctl.qrCheck = check
    ctl.qrFetch = fetch
    current = ctl
    ctl.showQR(instruction: instruction)
    ctl.requestQRCode()
  }

  /// data:image/<type>;base64,<...> → NSImage. Deliberately narrow: only a
  /// base64 data: URI, only an image/ type. The string arrives from a local
  /// container by way of the connect server, and this is the one place it
  /// could become anything other than pixels.
  private static func decodeDataImage(_ uri: String) -> NSImage? {
    guard uri.hasPrefix("data:image/"),
          let comma = uri.firstIndex(of: ","),
          uri[uri.startIndex..<comma].hasSuffix(";base64")
    else { return nil }
    let b64 = String(uri[uri.index(after: comma)...])
    guard let data = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]),
          !data.isEmpty, let image = NSImage(data: data), image.size.width > 0
    else { return nil }
    return image
  }

  /// Raise a login window from the widget's non-activating Settings panel.
  ///
  /// `NSApp.activate` does not finish synchronously. When a login is launched
  /// from an `NSPanel` carrying `.nonactivatingPanel`, making the new window key
  /// in the same run-loop turn can be ignored while AppKit is still activating
  /// the process. The request has already started (the tile spinner proves it),
  /// but the window remains behind Settings until a second press gives AppKit a
  /// later turn. Order it once immediately and once after activation settles;
  /// the second pass is idempotent and scoped to the still-current login.
  private func presentLoginWindow(_ win: NSWindow) {
    NSApp.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)
    DispatchQueue.main.async { [weak self, weak win] in
      guard let self, !self.finished, self.window === win, let win else { return }
      NSApp.activate(ignoringOtherApps: true)
      win.makeKeyAndOrderFront(nil)
      win.orderFrontRegardless()
    }
  }

  private func showQR(instruction: String) {
    // Sized to the content, top down: 34 under the header, the code, then the
    // one line that says what to do with it. A QR window with room left over
    // reads as a window still loading.
    let W: CGFloat = 420, headH: CGFloat = 62, bodyH: CGFloat = 400
    func color(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
      NSColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }
    let mono = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    let content = NSView(frame: NSRect(x: 0, y: 0, width: W, height: bodyH + headH))
    content.wantsLayer = true
    content.layer?.backgroundColor = color(0x14, 0x14, 0x12).cgColor

    // The code on WHITE, always — a QR reader needs the quiet zone and the
    // contrast, and this app's surfaces are all dark. The card is drawn before
    // the code exists so the window has its final shape from the first frame
    // and nothing jumps when the image lands.
    let side: CGFloat = 260
    let cardY = bodyH - 34 - side
    let card = NSView(frame: NSRect(x: (W - side) / 2, y: cardY, width: side, height: side))
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.white.cgColor
    card.layer?.cornerRadius = 10
    let shot = NSImageView(frame: NSRect(x: 10, y: 10, width: side - 20, height: side - 20))
    shot.imageScaling = .scaleProportionallyUpOrDown
    card.addSubview(shot)
    qrView = shot

    // Something is turning while the bridge is asked for a code. It sits ON
    // the white card, where the code is about to be, and goes away with it.
    let spin = NSProgressIndicator(frame: NSRect(x: side / 2 - 16, y: side / 2 - 16, width: 32, height: 32))
    spin.style = .spinning
    spin.controlSize = .regular
    // AQUA, against the app's dark appearance. A spinner inherits the window's
    // appearance and draws light spokes under a dark one — invisible on the
    // white card it sits on, which is what the first build of this window
    // showed: a blank white square for four seconds.
    spin.appearance = NSAppearance(named: .aqua)
    spin.startAnimation(nil)
    card.addSubview(spin)
    qrSpinner = spin

    let how = NSTextField(wrappingLabelWithString: instruction)
    how.font = mono
    how.textColor = color(0xc5, 0xa5, 0x6d)
    how.backgroundColor = .clear
    how.isBordered = false
    how.isEditable = false
    how.alignment = .center
    // Two short lines fit without clipping and leave room for an explicit retry
    // below. QR codes routinely expire while the phone is being unlocked, so
    // closing the window at that moment used to make a normal retry look like
    // a broken connector.
    how.frame = NSRect(x: 24, y: cardY - 62, width: W - 48, height: 44)
    how.isHidden = true // nothing to instruct until there is a code to scan
    qrHow = how

    let retry = NSButton(frame: NSRect(x: W / 2 - 58, y: cardY - 96, width: 116, height: 28))
    retry.title = "retry code"
    retry.bezelStyle = .rounded
    retry.controlSize = .small
    retry.target = self
    retry.action = #selector(retryQRCode)
    retry.isHidden = true
    qrRetry = retry

    let header = makeHeader(width: W, height: headH)
    header.frame = NSRect(x: 0, y: bodyH, width: W, height: headH)
    header.autoresizingMask = [.width, .minYMargin]
    content.addSubview(card)
    content.addSubview(how)
    content.addSubview(retry)
    content.addSubview(header)

    let win = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: W, height: bodyH + headH),
      styleMask: [.titled, .closable], backing: .buffered, defer: false
    )
    win.title = ""
    win.level = .normal
    win.isReleasedWhenClosed = false
    win.delegate = self
    win.contentView = content
    win.center()
    self.window = win
    presentLoginWindow(win)
  }

  @objc private func retryQRCode() { requestQRCode() }

  /// Ask for a fresh remote-auth code. The bridge generates these one at a
  /// time, so retry deliberately starts a new attempt rather than trying to
  /// revive the old Matrix event.
  private func requestQRCode() {
    guard !finished, let fetch = qrFetch else { return }
    poll?.invalidate(); poll = nil
    qrExpiry = nil
    qrNextCheck = Date.distantFuture
    qrView?.image = nil
    qrHow?.isHidden = false
    qrHow?.stringValue = "getting a fresh code…"
    qrRetry?.isHidden = true
    fetch { [weak self] uri in
      DispatchQueue.main.async {
        guard let self, !self.finished else { return }
        guard let uri, let image = Self.decodeDataImage(uri) else {
          self.qrSpinner?.stopAnimation(nil)
          self.qrSpinner?.removeFromSuperview()
          self.qrSpinner = nil
          self.qrHow?.stringValue = "couldn't get a code — try again"
          self.qrRetry?.isHidden = false
          return
        }
        self.fillQR(image)
      }
    }
  }

  /// The code arrived: swap it for the spinner, name exactly what needs to be
  /// done on the phone, and make its short lifetime visible. The remote-auth
  /// bridge expires a code after about a minute; a retry remains in this same
  /// window instead of returning the person to an ambiguous card status.
  private func fillQR(_ image: NSImage) {
    qrSpinner?.stopAnimation(nil)
    qrSpinner?.removeFromSuperview()
    qrSpinner = nil
    qrView?.image = image
    qrHow?.isHidden = false
    qrRetry?.isHidden = true
    qrExpiry = Date().addingTimeInterval(60)
    qrNextCheck = Date()
    updateQRCountdown()

    // Update the countdown every second; query the local bridge only every
    // 2.5 seconds. UI cadence and API cadence are intentionally independent.
    let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      self?.pollQRCode()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.poll = timer
  }

  private func updateQRCountdown() {
    guard let expiry = qrExpiry else { return }
    let seconds = max(0, Int(ceil(expiry.timeIntervalSinceNow)))
    qrHow?.stringValue = "Scan with Discord on your phone, then approve — expires in \(seconds) seconds"
  }

  private func expireQRCode() {
    poll?.invalidate(); poll = nil
    qrExpiry = nil
    qrHow?.stringValue = "That code expired — get a new one"
    qrRetry?.isHidden = false
  }

  private func pollQRCode() {
    guard !finished, let expiry = qrExpiry else { return }
    guard expiry.timeIntervalSinceNow > 0 else { expireQRCode(); return }
    updateQRCountdown()
    guard Date() >= qrNextCheck, let check = qrCheck else { return }
    qrNextCheck = Date().addingTimeInterval(2.5)
    check { [weak self] progress in
      DispatchQueue.main.async {
        guard let self, !self.finished else { return }
        switch progress {
        case .waiting: break
        case .connected: self.finish("connected")
        case .ended: self.expireQRCode()
        }
      }
    }
  }

  /// Retire the live website while keeping this exact native window alive for
  /// a local continuation. No web content, cookies, or script handler remains
  /// mounted behind the passcode UI.
  private func detachWebSurface() {
    poll?.invalidate(); poll = nil
    web?.stopLoading()
    web?.navigationDelegate = nil
    web?.uiDelegate = nil
    web = nil
    seenHeaders.removeAll()
    blink?.invalidate(); blink = nil
    headerTitle = nil
    headerHost = nil
    headerNotice = nil
  }

  /// Replace the website with one compact local step. Reuses the existing X
  /// window when there is one; a resumed passcode creates the same shell from
  /// scratch. The header deliberately switches from a live-domain claim to
  /// x.com plus local-storage copy because there is no page underneath now.
  private func installLocalBody(
    _ body: NSView, bodyHeight: CGFloat, notice: String = "data stored locally"
  ) {
    guard !finished else { return }
    // THE WINDOW'S OWN WIDTH, not 480. Messenger declares windowWidth 1000, so a
    // hardcoded 480 visibly shrank the window the moment a local body replaced
    // the page. presentPasscode constructs with 0, which init clamps to 480, so
    // X's three existing bodies are unchanged by this.
    let W: CGFloat = windowWidth, headH: CGFloat = 62
    detachWebSurface()
    let content = NSView(frame: NSRect(x: 0, y: 0, width: W, height: bodyHeight + headH))
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor(
      red: 0x14 / 255, green: 0x14 / 255, blue: 0x12 / 255, alpha: 1
    ).cgColor
    body.frame = NSRect(x: 0, y: 0, width: W, height: bodyHeight)
    let header = makeHeader(width: W, height: headH)
    header.frame = NSRect(x: 0, y: bodyHeight, width: W, height: headH)
    header.autoresizingMask = [.width, .minYMargin]
    content.addSubview(body)
    content.addSubview(header)
    // THE HEADER MUST STAY TRUE. It hardcoded x.com, which was right for the one
    // caller that existed and wrong for every other: a Facebook body would have
    // claimed x.com in the one place this app tells the owner which site they are
    // on. presentPasscode passes an empty cookieDomain, so X is unaffected.
    headerHost?.stringValue = cookieDomain.isEmpty ? "x.com" : cookieDomain
    headerNotice?.stringValue = notice

    if let win = window {
      win.setContentSize(NSSize(width: W, height: bodyHeight + headH))
      win.contentView = content
      presentLoginWindow(win)
    } else {
      let win = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: W, height: bodyHeight + headH),
        styleMask: [.titled, .closable], backing: .buffered, defer: false
      )
      win.title = ""
      win.level = .normal
      win.isReleasedWhenClosed = false
      win.delegate = self
      win.contentView = content
      win.center()
      window = win
      presentLoginWindow(win)
    }
  }

  /// The cookie handoff can take a few seconds to wake the bridge and receive
  /// its encrypted-DM question. Keep the flow visibly alive in the same window
  /// instead of dropping back to Settings during that gap.
  func showProgress(_ text: String = "setting up encrypted DMs…") {
    let body = NSView()
    let spinner = NSProgressIndicator(frame: NSRect(x: 104, y: 83, width: 24, height: 24))
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.startAnimation(nil)
    let line = NSTextField(labelWithString: text)
    line.font = NSFont(name: "Menlo", size: 14)
      ?? NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    line.textColor = NSColor(red: 0xea / 255, green: 0xea / 255, blue: 0xea / 255, alpha: 1)
    line.frame = NSRect(x: 142, y: 80, width: 280, height: 30)
    body.addSubview(spinner)
    body.addSubview(line)
    installLocalBody(body, bodyHeight: 190)
  }

  // WHEN THE SITE REFUSES TO RENDER AT ALL.
  //
  // Measured five times across four sessions on 2026-08-30. Facebook's two-step
  // verification page arrives fully server-rendered and displays nothing:
  //
  //   refused   kids 153-165  html ~2,480,000  vis 11   text ""  hidden 152
  //             shadow 0  ready complete  err []  wa {called:0}
  //             every laid-out element a bare <div> with no class
  //   working   kids 90       html ~326,000    vis 205  text present
  //             classes div.x9f619, div.x78zum5 — Facebook's real atomic CSS
  //
  // Not a crash, not a hang, not a blocked resource, no WebAuthn, no shadow DOM.
  // Meta server-renders the challenge and styles none of it into existence: it
  // declines to show a security step inside an embedded browser, the same posture
  // that makes Google refuse OAuth in one (see GoogleLogin.swift). X hits the same
  // wall one screen earlier. Five theories died before this one, four of them by
  // measurement, which is why the predicate below is written against numbers that
  // were actually observed rather than a plausible story.
  //
  // The owner cannot be left staring at it. Retire the page and offer the route
  // that does work.
  private func evaluateRefusal(_ json: String, on webView: WKWebView) {
    // EVERY EXIT SAYS WHY. The first version of this logged only on success, so a
    // detector that never fired and a detector that never ran looked identical in
    // the log — and the numbers said it should have fired, which left nothing to
    // read. Silence is not evidence.
    guard !refusalShown, !finished else { return }
    guard refusalArmed else { loginLog("refusal-skip \(label) not-armed"); return }
    guard looksRefused(json) else { return }
    refusalArmed = false
    loginLog("refusal-candidate \(label) — rechecking in 2.5s")
    // A SECOND LOOK, 2.5s later. The first sample cannot tell a refusal from a
    // React shell mid-mount; the second can, because a mounting page gains
    // layout and a refused one does not. The measured refusal held for minutes,
    // four separate times, so the delay is far past a mount and far short of it.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self, weak webView] in
      guard let self else { return }
      guard let webView else { self.loginLog("refusal-drop webview-gone"); return }
      guard !self.refusalShown, !self.finished else {
        self.loginLog("refusal-drop \(self.label) shown=\(self.refusalShown) finished=\(self.finished)")
        return
      }
      webView.evaluateJavaScript(Self.probeJS) { value, error in
        guard let again = value as? String else {
          self.loginLog("refusal-drop \(self.label) recheck-no-value \(error?.localizedDescription ?? "")")
          return
        }
        guard self.looksRefused(again) else {
          // NUMBERS, not a raw slice. JSON.stringify preserves insertion order,
          // so a 160-byte prefix of this object carried whatever the earlier keys
          // held regardless of what the last one was -- fixing `x` alone would not
          // have closed the channel.
          let d = (try? JSONSerialization.jsonObject(with: Data(again.utf8))) as? [String: Any]
          self.loginLog("refusal-drop \(self.label) recheck-recovered"
            + " vis=\(d?["vis"] as? Int ?? -1)"
            + " kids=\(d?["kids"] as? Int ?? -1)"
            + " html=\(d?["html"] as? Int ?? -1)"
            + " textLen=\(d?["x"] as? Int ?? -1)"
            + " shadow=\(d?["shadow"] as? Int ?? -1)")
          return
        }
        guard !self.finished, !self.harvestStarted else {
          self.loginLog("refusal-drop \(self.label) finished=\(self.finished) harvested=\(self.harvestStarted)")
          return
        }
        // Take the one-shot harvest funnel rather than racing it: a cookie poll
        // that lands after this returns early, and a genuine harvest that got
        // here first wins outright. One flag, two paths, no ordering to get wrong.
        self.harvestStarted = true
        self.refusalShown = true
        if self.allowsBrowserHandoff {
          self.loginLog("refused \(self.label) — site rendered nothing, offering browser handoff")
          self.showBrowserHandoff()
        } else {
          self.loginLog("refused \(self.label) — browser handoff disabled, offering in-app retry")
          self.showFailure("The security check didn't load — close this window and try again.")
        }
      }
    }
  }

  /// The predicate, over the probe JSON the didFinish handler already collects.
  ///
  /// Every threshold is a measured one. `html` is the floor that excludes a
  /// legitimately minimal page — a small page is small; a refused one is 2.4MB.
  /// The vis-to-kids ratio is what separates "almost nothing has a box" from a
  /// page that simply has few elements: 11*8 <= 153 fires, 205*8 <= 90 does not.
  private func looksRefused(_ json: String) -> Bool {
    guard let data = json.data(using: .utf8),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          (o["ready"] as? String) == "complete",
          (o["x"] as? Int) == 0,
          (o["shadow"] as? Int) == 0,
          let html = o["html"] as? Int, html >= 400_000,
          let kids = o["kids"] as? Int, kids >= 24,
          let vis = o["vis"] as? Int, vis >= 0, vis <= 24,
          vis * 8 <= kids
    else { return false }
    return true
  }

  /// One sentence naming the cause, and one control. No retry, no apology.
  ///
  /// This deliberately does NOT reuse showFailure: that renders a label and never
  /// finishes, so its only exit is the close box, which reports "cancelled" — and
  /// connections.js renders cancelled as nothing at all. A dead end is a worse
  /// answer than the wall itself.
  ///
  /// It also is not the paste box that was removed on 2026-08-25 for making every
  /// login button read as expected to fail. That one sat under a working control.
  /// This replaces a window that has already failed, and names why.
  private func showBrowserHandoff() {
    let W = windowWidth
    let body = NSView(frame: NSRect(x: 0, y: 0, width: W, height: 210))

    let title = NSTextField(labelWithString: "Finish this step in your browser")
    title.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .bold)
    title.textColor = NSColor(white: 0.92, alpha: 1)
    title.frame = NSRect(x: 24, y: 150, width: W - 48, height: 22)
    body.addSubview(title)

    let blurb = NSTextField(wrappingLabelWithString:
      "\(label) won't display this security step inside an app window. Your "
      + "browser can. Sign in there and the connect page picks the session up.")
    blurb.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    blurb.textColor = NSColor(white: 0.54, alpha: 1)
    blurb.frame = NSRect(x: 24, y: 74, width: W - 48, height: 66)
    body.addSubview(blurb)

    // ↗ is this repo's contract for "leaves the app".
    let go = NSButton(title: "open the connect page ↗", target: self,
                      action: #selector(pressBrowserHandoff))
    go.bezelStyle = .rounded
    go.keyEquivalent = "\r"
    go.frame = NSRect(x: 24, y: 24, width: 240, height: 32)
    body.addSubview(go)

    // "nothing was sent" rather than "data stored locally": no credential was
    // captured here, and saying so is the whole reassurance the moment needs.
    installLocalBody(body, bodyHeight: 210, notice: "nothing was sent")
  }

  @objc private func pressBrowserHandoff() {
    // The terminal outcome must be a deliberate press. Closing the window reports
    // "cancelled", which the UI renders as nothing.
    finish(Self.browserHandoff)
  }

  func showFailure(_ text: String) {
    let body = NSView()
    let line = NSTextField(wrappingLabelWithString: text)
    line.font = NSFont(name: "Menlo", size: 14)
      ?? NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    line.textColor = NSColor(red: 0xff / 255, green: 0x90 / 255, blue: 0x68 / 255, alpha: 1)
    line.alignment = .center
    line.frame = NSRect(x: 46, y: 62, width: 388, height: 66)
    body.addSubview(line)
    installLocalBody(body, bodyHeight: 190)
  }

  func completeInlineLogin() { finish("connected") }

  /// Turn the web login window into X's local four-digit step. The value is
  /// never logged, persisted, or echoed; `submit` relays it over the existing
  /// loopback bridge channel and reports only connected/retry state.
  func showPasscode(question: String, submit: @escaping PasscodeSubmit) {
    passcodeSubmit = submit
    let creating = question.range(of: "create", options: [.caseInsensitive]) != nil
    let body = NSView()
    let mono = NSFont(name: "Menlo", size: 13)
      ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let monoBold = NSFont(name: "Menlo Bold", size: 15)
      ?? NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
    let fg = NSColor(red: 0xea / 255, green: 0xea / 255, blue: 0xea / 255, alpha: 1)
    let muted = NSColor(red: 0x8a / 255, green: 0x8a / 255, blue: 0x8a / 255, alpha: 1)

    let title = NSTextField(labelWithString: creating
      ? "create a 4-digit X Chat passcode"
      : "enter your 4-digit X Chat passcode")
    title.font = monoBold
    title.textColor = fg
    title.frame = NSRect(x: 30, y: 188, width: 420, height: 28)

    let why = NSTextField(wrappingLabelWithString:
      "This unlocks your encrypted DMs. It is not your X password or 2FA code.")
    why.font = mono
    why.textColor = muted
    why.frame = NSRect(x: 30, y: 126, width: 420, height: 48)

    let field = NSSecureTextField(frame: NSRect(x: 30, y: 76, width: 260, height: 34))
    field.font = NSFont(name: "Menlo", size: 18)
      ?? NSFont.monospacedSystemFont(ofSize: 18, weight: .regular)
    field.placeholderString = "4 digits"
    field.delegate = self
    field.maximumNumberOfLines = 1
    passcodeField = field

    let button = NSButton(frame: NSRect(x: 308, y: 76, width: 122, height: 34))
    button.title = creating ? "create" : "continue"
    passcodeIdleTitle = button.title
    button.bezelStyle = .rounded
    button.font = monoBold
    button.target = self
    button.action = #selector(submitPasscode)
    button.keyEquivalent = "\r"
    passcodeButton = button

    let error = NSTextField(labelWithString: "")
    error.font = mono
    error.textColor = NSColor(red: 0xff / 255, green: 0x90 / 255, blue: 0x68 / 255, alpha: 1)
    error.frame = NSRect(x: 30, y: 40, width: 400, height: 22)
    passcodeError = error

    body.addSubview(title)
    body.addSubview(why)
    body.addSubview(field)
    body.addSubview(button)
    body.addSubview(error)
    installLocalBody(body, bodyHeight: 245)
    window?.makeFirstResponder(field)
  }

  func controlTextDidChange(_ obj: Notification) {
    guard let field = obj.object as? NSSecureTextField, field === passcodeField else { return }
    let digits = String(field.stringValue.filter(\.isNumber).prefix(4))
    if digits != field.stringValue { field.stringValue = digits }
    passcodeError?.stringValue = ""
  }

  @objc private func submitPasscode() {
    guard let submit = passcodeSubmit, let field = passcodeField else { return }
    let value = field.stringValue
    guard value.range(of: "^[0-9]{4}$", options: .regularExpression) != nil else {
      passcodeError?.stringValue = "enter all 4 digits"
      window?.makeFirstResponder(field)
      return
    }
    passcodeError?.stringValue = ""
    passcodeButton?.isEnabled = false
    passcodeButton?.title = "checking…"
    submit(value) { [weak self] outcome in
      DispatchQueue.main.async {
        guard let self, !self.finished else { return }
        switch outcome {
        case .connected:
          field.stringValue = ""
          self.finish("connected")
        case .retry(let message):
          field.stringValue = ""
          self.passcodeButton?.isEnabled = true
          self.passcodeButton?.title = self.passcodeIdleTitle
          self.passcodeError?.stringValue = message
          self.window?.makeFirstResponder(field)
        }
      }
    }
  }

  /// One-shot cookie harvest. X hands the payload to its inline continuation;
  /// every other platform preserves the original close-and-return behavior.
  private func completeHarvest(_ json: String) {
    guard !harvestStarted else { return }
    harvestStarted = true
    if let afterHarvest {
      poll?.invalidate(); poll = nil
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.finished else { return }
        self.showProgress()
        afterHarvest(json, self)
      }
    } else {
      finish(json)
    }
  }

  private func show(url: URL) {
    let W: CGFloat = windowWidth, webH: CGFloat = 680, headH: CGFloat = 62
    let config = WKWebViewConfiguration()
    // EVERY PLATFORM IS EPHEMERAL AGAIN.
    //
    // ~~Messenger got WKWebsiteDataStore.default()~~ on the theory that Facebook
    // needed a persistent store to render its first-visit bootstrap. That could
    // never have worked: clearsWebsiteData was set for the same platform, and
    // finish() wipes allWebsiteDataTypes since epoch 0 on EVERY exit including
    // cancel -- so the store was empty on arrival every single time, and every
    // visit was a first visit. It was strictly worse than .nonPersistent() on
    // both counts: it changed nothing about rendering, and it emptied the app's
    // SHARED default store, which belongs to every other webview in the process.
    //
    // The blank page was never about storage OR width. Measured from the login
    // window itself (~/.hazlie/logs/bridge-login.log, 2026-08-30): the LOGIN page
    // renders correctly -- "Log into Facebook / Log in / Forgot password?", 983
    // wide -- and the blank document is a DIFFERENT page reached 24 seconds
    // later, www.facebook.com/two_step_verification/authentication, which loads
    // with an empty body. Two theories died on that one line.
    let dataStore = WKWebsiteDataStore.nonPersistent()
    config.websiteDataStore = dataStore
    websiteDataStore = dataStore

    // WHY IS THE BODY EMPTY? An empty body is two different failures wearing
    // the same face: a page that legitimately rendered nothing, and a page whose
    // script threw before it could render. Only a handler installed BEFORE the
    // page's own code can tell them apart, so this goes in at document start and
    // accumulates; didFinish reads it back.
    //
    // Errors only, capped at six, message text only -- no stack and no source
    // URL, so nothing here can carry a query string or a token into a log file.
    // STOP CLAIMING A CAPABILITY THIS WINDOW DOES NOT HAVE.
    //
    // WKWebView inside a non-browser app exposes window.PublicKeyCredential, so
    // a site's feature detection passes — and then navigator.credentials.get()
    // has no platform authenticator behind it. X takes exactly that route: it
    // sent the owner to twitter.com/i/u2f_bridge, a page titled "Passkey
    // verification" that renders perfectly and says "your browser will prompt
    // you for your security key". It never will. Measured 2026-08-30.
    //
    // The honest fix is not to intercept the prompt, it is to stop advertising.
    // Feature detection exists precisely so a site can pick a method that works,
    // and this webview genuinely cannot do WebAuthn: the entitlement that would
    // allow it is Apple-managed and browser-only. Removing the advertisement
    // routes X to a second factor it CAN complete — an authenticator code — and
    // does the same for any other site that offers a choice.
    //
    // Deleted narrowly. navigator.credentials stays: it also carries password
    // credential APIs that autofill uses, and breaking those would trade one
    // dead end for another. Only the WebAuthn feature flag goes.
    let webAuthnOptOut =
      "try {" +
      "  if (window.PublicKeyCredential) { delete window.PublicKeyCredential; }" +
      "  if (window.AuthenticatorAssertionResponse) { delete window.AuthenticatorAssertionResponse; }" +
      "  if (window.AuthenticatorAttestationResponse) { delete window.AuthenticatorAttestationResponse; }" +
      "} catch (e) {}"
    config.userContentController.addUserScript(WKUserScript(
      source: webAuthnOptOut, injectionTime: .atDocumentStart, forMainFrameOnly: false))

    let errorProbe =
      "window.__hzErr = [];" +
      "window.addEventListener('error', function (e) {" +
      "  if (window.__hzErr.length < 6) {" +
      // A CLASS, NOT A MESSAGE. e.message is site-controlled free text — a page
      // that throws `new Error('login failed: ' + body)` puts that body in our
      // log. The name answers the only question this was ever asked ("did a
      // script die before the page rendered"), and across every recorded sample
      // this array was empty, so nothing diagnostic is lost.
      "    window.__hzErr.push(String((e && e.error && e.error.name) || 'error').slice(0, 40));" +
      "  }" +
      "}, true);" +
      "window.addEventListener('unhandledrejection', function (e) {" +
      "  if (window.__hzErr.length < 6) {" +
      "    window.__hzErr.push('reject:' + String((e && e.reason && e.reason.name) || '?').slice(0, 40));" +
      "  }" +
      "});" +
      "window.__hzWA = {called: 0, settled: 0, err: ''};" +
      "try {" +
      "  if (navigator.credentials && navigator.credentials.get) {" +
      "    var __g = navigator.credentials.get.bind(navigator.credentials);" +
      "    navigator.credentials.get = function (o) {" +
      "      window.__hzWA.called += 1;" +
      "      var p = __g(o);" +
      "      p.then(function () { window.__hzWA.settled += 1; }," +
      "             function (e) { window.__hzWA.settled += 1;" +
      "               window.__hzWA.err = String((e && e.name) || e).slice(0, 60); });" +
      "      return p;" +
      "    };" +
      "  }" +
      "} catch (e) {}"
    config.userContentController.addUserScript(WKUserScript(
      source: errorProbe, injectionTime: .atDocumentStart, forMainFrameOnly: false))

    // HEADER CAPTURE, only when the bridge asked for headers. LinkedIn's login
    // step wants X-LI-Track and X-LI-Page-Instance, which its own JavaScript
    // attaches to its XHRs — they are in no cookie jar and on no navigation, so
    // the only place they exist is the moment the page sets them. This wraps
    // XMLHttpRequest.setRequestHeader and fetch to report the ones named in the
    // contract, and nothing else: the allow-list is built from `fields`, so the
    // script cannot become a general reader of the page's traffic.
    // A CAPTCHA field watches the challenge widget's own output. reCAPTCHA
    // writes its response token into a hidden field once the person passes;
    // this polls for it and reports nothing else. It cannot answer a
    // challenge and is not trying to — it reads the receipt of one that a
    // human already answered, which is exactly what the bridge asks for.
    if fields.contains(where: { $0["from"] == "captcha" }) {
      config.userContentController.add(self, name: Self.headerHandler)
      let js = """
      (function () {
        var sent = '';
        setInterval(function () {
          try {
            var el = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
            var v = el && el.value;
            if (v && v !== sent) {
              sent = v;
              window.webkit.messageHandlers.\(Self.headerHandler)
                .postMessage({ name: '\(Self.captchaKey)', value: String(v) });
            }
          } catch (e) {}
        }, 500);
      })();
      """
      config.userContentController.addUserScript(
        WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: false)
      )
    }

    // A STORAGE FIELD READS ONE PATTERN OUT OF THE PAGE'S OWN localStorage, and
    // it exists because Slack's session is two halves that live in two places.
    // The `d` cookie is in the cookie jar and native can read it; the client
    // token is not a cookie at all — Slack's web app keeps it in localStorage —
    // so the ONLY way to obtain it is from inside the page.
    //
    // This is the same value the card used to ask the owner to copy out of
    // devtools by hand, which was the most alarming thing this app has ever put
    // on screen. Reading it here is strictly less exposure than that: it never
    // appears on screen, never goes through the clipboard, and goes straight to
    // the local bridge that needs it.
    //
    // NARROW BY CONSTRUCTION, and it has to stay that way. It matches ONE
    // pattern, named by the server's field contract; it reports the first
    // match and then only reports changes; it reads localStorage and nothing
    // else — no cookies, no DOM, no traffic. It cannot become a general reader
    // of the page, which is the same rule the header capture above follows.
    for f in fields where f["from"] == "storage" {
      guard let id = f["id"], let pattern = f["match"], !pattern.isEmpty else { continue }
      config.userContentController.add(self, name: Self.headerHandler)
      let esc = pattern.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "'", with: "\\'")
      let js = """
      (function () {
        var sent = '';
        var re = new RegExp('\(esc)[A-Za-z0-9._-]+');
        setInterval(function () {
          try {
            for (var i = 0; i < localStorage.length; i += 1) {
              var v = localStorage.getItem(localStorage.key(i));
              if (typeof v !== 'string') continue;
              var m = v.match(re);
              if (m && m[0] && m[0] !== sent) {
                sent = m[0];
                window.webkit.messageHandlers.\(Self.headerHandler)
                  .postMessage({ name: '\(Self.storagePrefix)\(id)', value: m[0] });
                return;
              }
            }
          } catch (e) {}
        }, 700);
      })();
      """
      config.userContentController.addUserScript(
        WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
    }

    let wanted = fields.compactMap { $0["from"] == "header" ? $0["header"] : nil }
    if !wanted.isEmpty {
      config.userContentController.add(self, name: Self.headerHandler)
      let names = (try? JSONSerialization.data(withJSONObject: wanted.map { $0.lowercased() }))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
      let js = """
      (function () {
        var want = new Set(\(names));
        function say(n, v) {
          try {
            if (!want.has(String(n).toLowerCase()) || !v) return;
            window.webkit.messageHandlers.\(Self.headerHandler)
              .postMessage({ name: String(n), value: String(v) });
          } catch (e) {}
        }
        var setH = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (n, v) {
          say(n, v);
          return setH.apply(this, arguments);
        };
        var f = window.fetch;
        if (f) {
          window.fetch = function (input, init) {
            try {
              var h = (init && init.headers) || (input && input.headers);
              if (h) {
                if (typeof h.forEach === 'function') h.forEach(function (v, k) { say(k, v); });
                else Object.keys(h).forEach(function (k) { say(k, h[k]); });
              }
            } catch (e) {}
            return f.apply(this, arguments);
          };
        }
      })();
      """
      config.userContentController.addUserScript(
        WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false)
      )
    }
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: webH), configuration: config)
    web.autoresizingMask = [.width, .height]
    web.navigationDelegate = self // OUR delegate, never Bridge's
    web.uiDelegate = self          // and the one that catches popups
    self.web = web

    // Intaglio Labs chrome above the real login page. A login window is the most
    // impersonation-shaped surface this app has, so the FRAME must read as
    // Intaglio Labs (terminal palette, mono) — a fake with default system chrome then
    // stands out. It names the real domain — the header's host line, kept
    // current as the page navigates — so the owner can see they're on the
    // genuine site, and states plainly that Intaglio Labs never sees the password.
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
    presentLoginWindow(win)

    // A real Safari user-agent. WKWebView's default UA carries no Safari
    // marketing token, and the big login SPAs — x.com most visibly — serve a
    // blank page to it (the owner saw an empty white window on X). A stock
    // desktop-Safari string makes them render their normal login flow.
    // Per-platform when the policy names one, the system's own Safari version
    // otherwise — see systemSafariUserAgent for why that is READ and not
    // written down.
    web.customUserAgent = userAgent.isEmpty ? Self.systemSafariUserAgent : userAgent
    showHost(url)
    web.load(URLRequest(url: url))

    // Poll the webview's own cookie store for the session cookie. When it
    // appears with a value, the user is logged in — harvest and finish.
    let timer = Timer(timeInterval: 1.2, repeats: true) { [weak self] _ in
      self?.checkCookies()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.poll = timer
  }

  /// The domain line under the title. Updated as the page navigates, so it
  /// names where you ACTUALLY are rather than where the window started.
  private var headerHost: NSTextField?
  private var headerNotice: NSTextField?

  // The terminal-palette, mono header. Values mirror the connect page's
  // "Terminal Palette v0.2" so Intaglio Labs' login window is visually of a piece with
  // the rest of the app.
  private func makeHeader(width: CGFloat, height: CGFloat) -> NSView {
    func color(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
      NSColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }
    let bg = color(0x14, 0x14, 0x12)
    let muted = color(0x8a, 0x8a, 0x8a)
    let mono = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    // The domain is the one fact in this header worth reading, so it gets the
    // weight and the full-strength foreground; everything around it stays quiet.
    let monoBold = NSFont(name: "Menlo Bold", size: 12)
      ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
    let fg = color(0xea, 0xea, 0xea)

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
    // THE DOMAIN, and it was claimed here before it was shown. The comment at
    // show(url:) has said this header "names the real domain, so the owner can
    // see they're on the genuine site" since it was written; the header showed
    // the platform's LABEL and nothing else, so the one fact that distinguishes
    // the genuine site from a convincing copy was the one it left out
    // (2026-08-26).
    //
    // It also does real work for a password manager. 1Password's universal
    // autofill reads a browser's address bar to pick an item and cannot read
    // one here, because this is an app window rather than a browser — so the
    // owner searches, and the domain is the search term.
    // THE DOMAIN, on its own line under the title.
    //
    // ~~A boxed bar with a lock, then the whole url.~~ Both tried and both
    // reverted (owner, 2026-08-27): the lock is a summary somebody has to be
    // trusted for, and a full url in a mono face is a wall of text that reads as
    // less trustworthy, not more, in a window this size. The domain is the fact
    // that matters and it is the one a reader can actually check at a glance.
    //
    // It is live either way -- didCommit renames it on every navigation, so a
    // login that hops hosts (Slack's SSO reaches accounts.google.com) never
    // leaves a stale claim on screen.
    //
    // It also does real work for a password manager. 1Password's universal
    // autofill reads a browser's address bar and cannot read one here, because
    // this is an app window rather than a browser -- so the owner searches, and
    // the domain is the search term.
    let host = makeLabel("", font: monoBold, color: fg, y: 10)
    headerHost = host
    // The trust fact, quieter and to the right: it is a promise about this app,
    // not a property of the page, so it must not compete with the domain for the
    // eye. Same line, opposite end -- which is also what stops the two of them
    // colliding as a domain grows.
    let sub = makeLabel(
      "your credentials stay local",
      font: mono, color: muted, y: 10
    )
    sub.alignment = .right
    headerNotice = sub
    view.addSubview(title)
    view.addSubview(host)
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

  /// The message-handler name the injected script posts to. One constant so
  /// the script and the registration cannot drift.
  fileprivate static let headerHandler = "hzHeader"
  /// Where a captured CAPTCHA token is filed. Not a header name, so it cannot
  /// collide with one a contract asks for.
  fileprivate static let captchaKey = "__captcha"
  /// Storage-field values arrive under this prefix plus the field id, so one
  /// handler serves headers, the captcha and storage without them colliding.
  fileprivate static let storagePrefix = "__storage:"

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.name == Self.headerHandler,
          let body = message.body as? [String: Any],
          let name = body["name"] as? String,
          let value = body["value"] as? String,
          !value.isEmpty
    else { return }
    // Bounded: a header this window was not told to collect is dropped by the
    // script already, and an absurd value is not worth keeping either.
    // reCAPTCHA tokens run long — several KB is normal, and truncating one
    // would fail validation on the far side for no visible reason.
    guard value.count <= 16384 else { return }
    seenHeaders[name.lowercased()] = value
    // A header can arrive after the cookies are already in place, which is the
    // usual order — the session cookie lands at login, the XHR headers on the
    // first page the app renders afterwards.
    checkCookies()
  }

  private func checkCookies() {
    // An approval window has no finish condition to poll for: the person is
    // done when they say so, and the bridge reports the result.
    if approval { return }
    guard let store = web?.configuration.websiteDataStore.httpCookieStore else { return }
    store.getAllCookies { [weak self] cookies in
      guard let self, !self.finished else { return }
      let mine = cookies.filter { self.domainMatches($0.domain) }
      // ALL required cookies, not just the session signal — the poll simply
      // keeps waiting until the platform has set every one. An empty list is
      // a login that waits on its fields instead (Slack's CAPTCHA window).
      let have = Set(mine.filter { !$0.value.isEmpty }.map { $0.name })
      guard self.requiredCookies.allSatisfy({ have.contains($0) }) else { return }
      // THE FIELD CONTRACT, when the bridge declared one. Every field must be
      // satisfied before the window finishes: a partial payload is a login
      // that looks done and is refused on the far side, which is the failure
      // mode this whole path has been walking through.
      if !self.fields.isEmpty {
        // "name=value; name=value" — values unaltered, because LinkedIn's
        // JSESSIONID carries its own quotes and the regex expects them.
        let cookieHeader = mine.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        var payload: [String: String] = [:]
        for f in self.fields {
          guard let id = f["id"] else { continue }
          switch f["from"] {
          case "cookies":
            payload[id] = cookieHeader
          case "header":
            guard let name = f["header"],
                  let v = self.seenHeaders[name.lowercased()], !v.isEmpty else { return }
            payload[id] = v
          case "captcha":
            // The token the PERSON's answer produced. Nothing here answers a
            // challenge — the window shows the platform's own page and waits.
            guard let v = self.seenHeaders[Self.captchaKey], !v.isEmpty else { return }
            payload[id] = v
          case "cookie":
            // ONE NAMED COOKIE, not the whole header. Slack's bridge wants the
            // `d` cookie's value on its own, under its own key, beside a token
            // that is not a cookie at all — a cookie HEADER would hand it a
            // string it has no way to split.
            guard let name = f["cookie"],
                  let c = mine.first(where: { $0.name == name }), !c.value.isEmpty
            else { return }
            payload[id] = c.value
          case "storage":
            // Read from inside the page by the poller above, because this half
            // of the session is not in any cookie jar.
            guard let v = self.seenHeaders[Self.storagePrefix + id], !v.isEmpty else {
              // SIGNED IN, ON THE WRONG PAGE. Slack's sign-in ends on an
              // interstitial that offers to launch the desktop app — "Click
              // Open Slack... or use Slack in your browser" — and that page
              // holds no token, because the token belongs to the web client
              // the link goes to. The cookies are already set, so the window
              // was silently waiting for a value that page was never going to
              // have (owner, 2026-08-26: "what do i do on this page? it seems
              // stuck").
              //
              // Nothing here is a workaround for a login that failed: the
              // login SUCCEEDED, and this walks the last step the owner would
              // otherwise have to know to take. Once, and only once the
              // required cookies are in hand, so it cannot loop and cannot
              // fire on a page where nobody has signed in.
              self.nudgeToStorage()
              return
            }
            payload[id] = v
          default:
            return
          }
        }
        guard payload.count == self.fields.count,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        self.completeHarvest(json)
        return
      }
      var bag: [String: String] = [:]
      for c in mine { bag[c.name] = c.value }
      guard let data = try? JSONSerialization.data(withJSONObject: bag),
            let json = String(data: data, encoding: .utf8) else { return }
      self.completeHarvest(json)
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
  /// Write the host into the header. Trimmed of a leading www., which is
  /// noise in every one of these and pushes the part that identifies the site.
  /// The domain, as the page reports it. `www.` is noise and is dropped.
  ///
  /// Not the full url and not a lock glyph -- both were tried and both were
  /// worse to read (see the header). The one thing kept from that attempt is the
  /// COLOUR: an unencrypted page turns the domain red, because that is the
  /// single fact a reader should not have to go looking for.
  private func showHost(_ url: URL?) {
    guard let url, let host = url.host, !host.isEmpty else { return }
    headerHost?.stringValue = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    let secure = url.scheme?.lowercased() == "https"
    headerHost?.textColor = secure
      ? NSColor(red: 0xea / 255, green: 0xea / 255, blue: 0xea / 255, alpha: 1)
      : NSColor(red: 0xff / 255, green: 0x53 / 255, blue: 0x47 / 255, alpha: 1)
  }

  // The domain follows the page. A login can hop hosts inside its own fence —
  // Slack's SSO buttons reach accounts.google.com and appleid.apple.com — and
  // a header still naming slack.com there would be a claim about where you are
  // that is no longer true, which is the opposite of what it is for.
  // WHAT DOCUMENT ARE WE ACTUALLY ON? Nothing recorded it, which is why two
  // rounds of Facebook diagnosis argued about a page nobody had read.
  //
  // facebook.com/login/ contains ZERO <img> elements -- verified in the served
  // HTML and in a live DOM -- so a broken-image glyph cannot come from its normal
  // response. Either the window is on a different document or the recollection is
  // off, and only a log can tell those apart. Counts and hosts only, never a
  // cookie, a query string or a form value.
  // TO A FILE, NOT NSLog. The first version of this used NSLog and produced
  // nothing readable: `log show --predicate 'process == "Hazlie"'` returned zero
  // lines across an hour that included a real reproduction, so the one
  // measurement this was added to take was silently unavailable. A diagnostic
  // nobody can read is worse than none, because it is mistaken for evidence of
  // absence. AssetScheme.swift already writes to ~/.hazlie/logs; this follows it.
  //
  // Always on, unlike AssetScheme's env-gated dbg: this fires once per completed
  // navigation in a window the owner opened deliberately, and the whole point is
  // to have the record ALREADY when a failure is reported, not to ask for a
  // repeat with a flag set.
  /// The one page probe, hoisted so didFinish and the refusal re-check run
  /// the SAME script. Two copies would drift, and the re-check exists to
  /// compare like with like.
  static let probeJS =
  "JSON.stringify({t:document.title,n:document.images.length," +
  "b:Array.from(document.images).filter(i=>!i.naturalWidth).length," +
  "w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth," +
  "f:document.querySelectorAll('iframe').length," +
  "kids:document.body?document.body.children.length:-1," +
  "html:document.body?document.body.innerHTML.length:-1," +
  "err:(window.__hzErr||[])," +
  // A 2.5MB DOM with no rendered text is content that exists and is not
  // shown. h/vis say whether ANYTHING has layout; wa says whether the page
  // is waiting on a WebAuthn assertion that will never arrive, which is
  // what a second-factor page in a non-browser WKWebView cannot get.
  "h:document.body?document.body.scrollHeight:-1," +
  "vis:document.body?Array.from(document.body.querySelectorAll('*')).filter(function(e){return e.offsetHeight>0}).length:-1," +
  "wa:(window.__hzWA||null)," +
  // WHAT IS ACTUALLY ON SCREEN. 11 laid-out elements and no text is a page
  // whose chrome rendered and whose content did not. Tag names and the first
  // class token only -- never text, never an attribute value, because this
  // page is a second factor and everything on it is sensitive.
  "shape:document.body?Array.from(document.body.querySelectorAll('*')).filter(function(e){return e.offsetHeight>0}).slice(0,14).map(function(e){return e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.split(' ')[0]:'')}):[]," +
  // innerText does not pierce a shadow root, so a shadowed page reads as
  // empty text with real height -- exactly this shape.
  "shadow:document.body?Array.from(document.body.querySelectorAll('*')).filter(function(e){return !!e.shadowRoot}).length:-1," +
  "ready:document.readyState," +
  // A hidden content region is the other candidate: count what exists but
  // has no box at all.
  "hidden:document.body?Array.from(document.body.querySelectorAll('*')).filter(function(e){return e.offsetParent===null&&e.offsetHeight===0}).length:-1," +
  // A LENGTH, NEVER THE CHARACTERS. This sliced the first 120 characters of
  // rendered text and loginLog wrote it verbatim, always on, for a window whose
  // entire purpose is a platform login and its second factor -- where that copy
  // is a masked phone fragment, an account hint, or the address a code went to.
  // The block above already refuses to log text or attribute values for exactly
  // this reason; this line was the hole in it. connectors/AGENTS.md forbids the
  // same thing in as many words, and there is no rotation or delete path on
  // this file at all. Behaviour-identical: looksRefused only ever asked whether
  // this was empty, so a count answers the same question.
  "x:document.body?document.body.innerText.trim().length:-1})"

  private func loginLog(_ line: String) {
    let fm = FileManager.default
    let f = fm.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/logs/bridge-login.log")
    let msg = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
    guard let data = msg.data(using: .utf8) else { return }
    // OWNER-ONLY, 0600. This landed as 0644 because `write(to:atomically:)`
    // takes the process umask, and a world-readable file is the wrong mode for a
    // record of which login pages somebody opened and what they rendered. Set on
    // creation AND corrected on an existing file, so an install that already has
    // the 0644 version is repaired rather than left as it was.
    if !fm.fileExists(atPath: f.path) {
      fm.createFile(atPath: f.path, contents: nil, attributes: [.posixPermissions: 0o600])
    } else {
      try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path)
    }
    // AND IT HAS TO END SOMEWHERE. This file had no rotation and no delete
    // path: it grew for the life of the install, and every line named a login
    // page the owner opened and when. Nothing else on this machine keeps a
    // record like that indefinitely -- hermes has a retention policy and the
    // corpus has /admin/purge. A debugging log for a first-run flow does not
    // need to outlive the first run, let alone the install.
    //
    // Drop the older half rather than the whole file, so a session that goes
    // wrong right after a rotation still has the lines leading up to it.
    if let h = try? FileHandle(forWritingTo: f) {
      h.seekToEndOfFile()
      if h.offsetInFile > 256 * 1024,
         let existing = try? Data(contentsOf: f) {
        let kept = existing.suffix(128 * 1024)
        // Start at a line boundary; a half-line at the top reads as corruption.
        let start = kept.firstIndex(of: 0x0A).map { kept.index(after: $0) } ?? kept.startIndex
        try? (kept[start...] + data).write(to: f, options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path)
        try? h.close()
        return
      }
      h.write(data); try? h.close()
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // kids/html distinguish "no DOM at all" from "DOM present, no text": a React
    // shell that mounted and rendered nothing looks nothing like a script that
    // died at parse. err is why, when there is a why.
    let js = Self.probeJS
    webView.evaluateJavaScript(js) { value, _ in
      let host = webView.url?.host ?? "?"
      let path = webView.url?.path ?? "?"
      self.loginLog("loaded \(self.label) \(host)\(path) \(value as? String ?? "{}")")
      // After the record is written, whatever happens next.
      if let probe = value as? String { self.evaluateRefusal(probe, on: webView) }
    }
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    refusalArmed = true // one evaluation per navigation

    showHost(webView.url)
    headerNotice?.stringValue = "your credentials stay local"
    headerNotice?.textColor = NSColor(red: 0x8a / 255, green: 0x8a / 255, blue: 0x8a / 255, alpha: 1)
  }

  private func showNavigationFailure(_ error: Error, url: URL?) {
    let host = url?.host?.hasPrefix("www.") == true
      ? String(url!.host!.dropFirst(4))
      : (url?.host ?? "this page")
    // `localizedDescription` is often a long, system-localized sentence. The
    // compact error code makes a report diagnosable while still telling the
    // person what to do, instead of preserving the old blank white failure.
    let code = (error as NSError).code
    headerNotice?.stringValue = "couldn't load \(host) (\(code)) — close and retry"
    headerNotice?.textColor = NSColor(red: 0xff / 255, green: 0x90 / 255, blue: 0x68 / 255, alpha: 1)
    NSLog("Intaglio Labs: social login navigation failed for \(host), code \(code): \(error.localizedDescription)")
  }

  // A BLANK WINDOW MOST LIKELY MEANS didFinish NEVER FIRED, so the failure paths
  // have to be as loud as the success path or the log cannot tell "the page
  // loaded and rendered nothing" from "the navigation died".
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loginLog("provisional-fail \(label) \(webView.url?.host ?? "?")\(webView.url?.path ?? "") \(error.localizedDescription)")
    showNavigationFailure(error, url: webView.url)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loginLog("nav-fail \(label) \(webView.url?.host ?? "?")\(webView.url?.path ?? "") \(error.localizedDescription)")
    showNavigationFailure(error, url: webView.url)
  }

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
    // TWO LISTS, BECAUSE A FRAME IS NOT A DESTINATION. The main frame is where
    // the owner types a password, so what may appear THERE stays the platform
    // and the identity providers its own login page offers. A subframe is a
    // widget embedded by the page that is already allowed, and a CAPTCHA is
    // made of them: a live reCAPTCHA loads www.google.com/recaptcha/api2/anchor
    // (the checkbox) and .../bframe (the image challenge), both as subframes,
    // measured on Google's own demo page in a fenced webview on 2026-08-26.
    //
    // Slack's challenge is reCAPTCHA — their boot_data carries
    // recaptcha_enterprise_migration and spam_email_recaptcha_v3, both on — so
    // without this split the fence cancels both iframes and the owner sees an
    // empty box where the puzzle should be. That is the same invisible failure
    // as the Google button one step earlier: a cancelled navigation renders as
    // nothing at all.
    //
    // ~~Adding www.google.com to allowedHosts~~ would have done it in one line
    // and is the wrong line: it lets the WINDOW ITSELF navigate to Google, in
    // the one webview in this app where a password is typed. A challenge needs
    // to render, not to take over the page.
    //
    // The subframe list is still an allowlist and still server-authored; it is
    // not "subframes are fine". Everything unlisted is cancelled in both, which
    // on Slack's own page means the doubleclick and contentsquare iframes their
    // marketing stack loads.
    // A FRAME BEING CREATED HAS NO targetFrame YET, and defaulting that to "main
    // frame" makes allowedFrameHosts dead for the only case it exists to serve.
    //
    // ~~targetFrame?.isMainFrame ?? true~~ meant a brand-new subframe -- which is
    // what a challenge widget always is on first load -- got checked against
    // allowedHosts instead of allowedFrameHosts, was cancelled, and logged
    // "blocked main-frame redirect". That is precisely the empty-CAPTCHA-box
    // failure the two-list split was written to prevent: Slack's reCAPTCHA loads
    // www.google.com/recaptcha/api2/anchor into a fresh iframe, and X serves an
    // Arkose/FunCaptcha subframe on a challenged login.
    //
    // sourceFrame is never nil, so it answers the question targetFrame cannot: a
    // navigation REQUESTED BY the main frame with no target frame yet is a
    // subframe the main frame is creating. Only a navigation whose target really
    // is the main frame gets main-frame treatment. Unknown still fails closed --
    // it lands in the subframe list, which is itself an allowlist.
    let inMain = navigationAction.targetFrame?.isMainFrame
      ?? (navigationAction.sourceFrame.isMainFrame && navigationAction.targetFrame != nil)
    let matches = { (list: [String]) in
      list.contains { host == $0 || host.hasSuffix("." + $0) }
    }
    let ok = matches(allowedSuffixes) || (!inMain && matches(allowedFrameSuffixes))
    // A CANCELLED SUBFRAME MUST NOT BE SILENT.
    //
    // The header notice below only fires for a main-frame block, so once the
    // targetFrame fix started classifying new subframes correctly, every
    // subframe this fence killed disappeared without a trace — and a challenge
    // widget IS a subframe. Facebook's 2FA page grew an iframe 2.5s after load
    // (f: 0 -> 1) and still rendered nothing, which is exactly the shape of a
    // frame that was created and then refused.
    //
    // Host only. A subframe URL can carry a challenge token in its query.
    if !ok && !inMain {
      loginLog("blocked-subframe \(label) \(host)")
    }
    if !ok && inMain {
      headerNotice?.stringValue = "blocked redirect to \(host) — close and retry"
      headerNotice?.textColor = NSColor(red: 0xff / 255, green: 0x90 / 255, blue: 0x68 / 255, alpha: 1)
      loginLog("blocked \(label) main-frame redirect to \(host)")
    }
    decisionHandler(ok ? .allow : .cancel)
  }

  // A POPUP IS STILL A NAVIGATION, and WKWebView's default answer to one is
  // silence. Without this method, `target="_blank"` and window.open() do
  // NOTHING AT ALL: no new window, no navigation, no error — the click lands
  // and the page sits there. The owner reported exactly that shape on Slack's
  // workspace list ("clicking open doesn't do anything", 2026-08-26), and it is
  // the third time in this flow that a silently dropped navigation has been
  // mistaken for a dead control.
  //
  // Opened IN PLACE rather than in a second window. A login window's whole
  // premise is that the owner can see which site they are on — the header names
  // the domain — and a second window would be an unlabelled webview with a
  // password field in it, which is the shape this app must never produce.
  //
  // The fence is not bypassed: this hands the request back to load(), and every
  // load goes through decidePolicyFor. A popup to a host that is not allowed is
  // cancelled there, exactly as a link to it would be.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
      webView.load(URLRequest(url: url))
    }
    return nil // never a second window
  }

  /// Walk a signed-in window to the page that actually holds the token.
  private func nudgeToStorage() {
    guard !nudged, !storageUrl.isEmpty, let url = URL(string: storageUrl) else { return }
    nudged = true
    DispatchQueue.main.async { [weak self] in self?.web?.load(URLRequest(url: url)) }
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

  // Single exit for every path: report once, stop polling, release the
  // ephemeral website store, close the window, release self.
  private func finish(_ result: String?) {
    if finished { return }
    finished = true
    poll?.invalidate(); poll = nil
    blink?.invalidate(); blink = nil
    headerTitle = nil
    headerNotice = nil
    qrCheck = nil
    qrFetch = nil
    qrView = nil
    qrSpinner?.stopAnimation(nil)
    qrSpinner = nil
    qrHow = nil
    qrRetry = nil
    qrExpiry = nil
    passcodeSubmit = nil
    passcodeField = nil
    passcodeButton = nil
    passcodeError = nil
    passcodeIdleTitle = "continue"
    let cb = done
    let win = window
    websiteDataStore = nil
    web?.navigationDelegate = nil
    web?.uiDelegate = nil
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
