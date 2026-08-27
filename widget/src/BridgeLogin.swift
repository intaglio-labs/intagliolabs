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

final class BridgeLogin: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, WKScriptMessageHandler {
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
  private let done: (String?) -> Void

  /// A QR WINDOW's two pieces: the image the bridge posted, and the closure
  /// that asks the bridge whether the scan has landed yet. Both nil for an
  /// ordinary web login — the two modes share this window's chrome and its
  /// single-exit teardown, and nothing else.
  private var qrCheck: ((@escaping (QRProgress) -> Void) -> Void)?
  private var qrView: NSImageView?
  private var qrSpinner: NSProgressIndicator?
  private var qrHow: NSTextField?

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
    requiredCookies: [String], cookieFormat: String, fields: [[String: String]],
    approval: Bool, userAgent: String, allowedFrameHosts: [String],
    storageUrl: String, done: @escaping (String?) -> Void
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
    self.storageUrl = storageUrl
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
    cookieFormat: String = "json", fields: [[String: String]] = [],
    approval: Bool = false, userAgent: String = "", allowedFrameHosts: [String] = [],
    storageUrl: String = "",
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
      allowedFrameHosts: allowedFrameHosts, storageUrl: storageUrl, done: done
    )
    current = ctl
    ctl.show(url: url)
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
  /// for one means sending `login` and waiting on a bot in a container —
  /// measured at 3.8s on this machine — and a tile that sits there for four
  /// seconds after a press reads as a tile that did not register the press
  /// (owner, 2026-08-26: "when i first tap discord icon nothing happens").
  /// Instagram's window is up in 30ms because its policy is static; this one
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
      approval: false, userAgent: "", allowedFrameHosts: [], storageUrl: "", done: done
    )
    ctl.qrCheck = check
    current = ctl
    ctl.showQR(instruction: instruction)
    fetch { [weak ctl] uri in
      DispatchQueue.main.async {
        guard let ctl, !ctl.finished else { return }
        guard let uri, let image = decodeDataImage(uri) else { ctl.finish(nil); return }
        ctl.fillQR(image)
      }
    }
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

  private func showQR(instruction: String) {
    // Sized to the content, top down: 34 under the header, the code, then the
    // one line that says what to do with it. A QR window with room left over
    // reads as a window still loading.
    let W: CGFloat = 420, headH: CGFloat = 62, bodyH: CGFloat = 358
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
    // 40pt tall so a longer platform name can wrap; text draws from the TOP of
    // that frame, which is what this offset is measured to.
    how.frame = NSRect(x: 24, y: cardY - 56, width: W - 48, height: 40)
    // ~~"waiting for the scan — this closes itself" under it.~~ Yeeted (owner,
    // 2026-08-26). The window is one instruction and one code; a second line
    // narrating that the window is still a window earns nothing.
    how.isHidden = true // nothing to instruct until there is a code to scan
    qrHow = how

    let header = makeHeader(width: W, height: headH)
    header.frame = NSRect(x: 0, y: bodyH, width: W, height: headH)
    header.autoresizingMask = [.width, .minYMargin]
    content.addSubview(card)
    content.addSubview(how)
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
    NSApp.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)
  }

  /// The code arrived: swap it for the spinner and say what to do with it.
  /// The poll starts HERE rather than at open, because there is nothing to
  /// approve until there is a code on screen.
  private func fillQR(_ image: NSImage) {
    qrSpinner?.stopAnimation(nil)
    qrSpinner?.removeFromSuperview()
    qrSpinner = nil
    qrView?.image = image
    qrHow?.isHidden = false

    // 2.5s: the remote-auth code lives about two minutes, so this is dozens of
    // asks over its whole life, not a busy loop.
    let timer = Timer(timeInterval: 2.5, repeats: true) { [weak self] _ in
      guard let self, let check = self.qrCheck, !self.finished else { return }
      check { [weak self] progress in
        guard let self, !self.finished else { return }
        switch progress {
        case .waiting: break
        case .connected: self.finish("connected")
        case .ended:
          // The card behind this window offers the way back (its begin
          // button), so ending here is a close, not a dead window with a
          // message in it.
          self.finish(nil)
        }
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    self.poll = timer
  }

  private func show(url: URL) {
    let W: CGFloat = 480, webH: CGFloat = 680, headH: CGFloat = 62
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent() // isolated + discarded on teardown

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

    NSApp.activate(ignoringOtherApps: true)
    win.makeKeyAndOrderFront(nil)

    // A real Safari user-agent. WKWebView's default UA carries no Safari
    // marketing token, and the big login SPAs — x.com most visibly — serve a
    // blank page to it (the owner saw an empty white window on X). A stock
    // desktop-Safari string makes them render their normal login flow.
    // Per-platform when the policy names one, the system's own Safari version
    // otherwise — see systemSafariUserAgent for why that is READ and not
    // written down.
    web.customUserAgent = userAgent.isEmpty ? Self.systemSafariUserAgent : userAgent
    showAddress(url)
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

  // The terminal-palette, mono header. Values mirror the connect page's
  // "Terminal Palette v0.2" so Intaglio Labs' login window is visually of a piece with
  // the rest of the app.
  private func makeHeader(width: CGFloat, height: CGFloat) -> NSView {
    func color(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
      NSColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }
    let bg = color(0x14, 0x14, 0x12)
    let muted = color(0x8a, 0x8a, 0x8a)
    let hazelnutDim = color(0xc5, 0xa5, 0x6d)
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
    // AN ADDRESS BAR, NOT A CAPTION.
    //
    // The domain was already live and already correct -- didCommit updates it on
    // every navigation, so a login that hops hosts renames the header. What it
    // was not, was legible AS an address: dim hazelnut at the same weight as the
    // sentence beside it, reading as decoration rather than as the one fact that
    // separates the genuine site from a convincing copy. The owner looked for an
    // address bar and did not find one.
    //
    // So it is drawn as a bar: boxed, brighter than its surroundings, carrying a
    // lock and the scheme, on its own line. Everything it claims is read from the
    // live URL rather than from the platform we THINK we opened.
    let bar = NSView(frame: NSRect(x: 16, y: 4, width: width - 32, height: 22))
    bar.wantsLayer = true
    bar.layer?.backgroundColor = color(0x0f, 0x0f, 0x0e).cgColor
    bar.layer?.borderColor = color(0x3a, 0x3a, 0x36).cgColor
    bar.layer?.borderWidth = 1
    bar.layer?.cornerRadius = 5
    bar.autoresizingMask = [.width]

    let host = NSTextField(labelWithString: "")
    host.font = NSFont(name: "Menlo Bold", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
    host.textColor = color(0xea, 0xea, 0xea)
    host.backgroundColor = .clear
    host.isBordered = false
    host.frame = NSRect(x: 8, y: 3, width: bar.frame.width - 16, height: 16)
    host.autoresizingMask = [.width]
    host.lineBreakMode = .byTruncatingMiddle
    headerHost = host
    bar.addSubview(host)

    // The trust fact moves up beside the title: it is a promise about this app,
    // not a property of the page, and sitting next to the address it read as a
    // claim about the SITE.
    let sub = makeLabel(
      "your credentials stay local",
      font: mono, color: muted, y: height - 30
    )
    sub.alignment = .right
    view.addSubview(title)
    view.addSubview(bar)
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
        self.finish(json)
        return
      }
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
  /// Write the host into the header. Trimmed of a leading www., which is
  /// noise in every one of these and pushes the part that identifies the site.
  /// The address line. Reads the LIVE url -- never the one we intended to open --
  /// and says plainly when a page is not encrypted, because "looks like a login
  /// form" is exactly what a copy also looks like.
  private func showAddress(_ url: URL?) {
    guard let url, let host = url.host, !host.isEmpty else { return }
    let shown = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    let secure = url.scheme?.lowercased() == "https"
    headerHost?.stringValue = secure ? "🔒 \(shown)" : "⚠ not secure — \(shown)"
    headerHost?.textColor = secure
      ? NSColor(red: 0xea / 255, green: 0xea / 255, blue: 0xea / 255, alpha: 1)
      : NSColor(red: 0xff / 255, green: 0x53 / 255, blue: 0x47 / 255, alpha: 1)
  }

  // The domain follows the page. A login can hop hosts inside its own fence —
  // Slack's SSO buttons reach accounts.google.com and appleid.apple.com — and
  // a header still naming slack.com there would be a claim about where you are
  // that is no longer true, which is the opposite of what it is for.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    showAddress(webView.url)
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
    let inMain = navigationAction.targetFrame?.isMainFrame ?? true
    let matches = { (list: [String]) in
      list.contains { host == $0 || host.hasSuffix("." + $0) }
    }
    let ok = matches(allowedSuffixes) || (!inMain && matches(allowedFrameSuffixes))
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

  // Single exit for every path: report once, stop polling, drop the webview and
  // its (non-persistent) data store, close the window, release self.
  private func finish(_ result: String?) {
    if finished { return }
    finished = true
    poll?.invalidate(); poll = nil
    blink?.invalidate(); blink = nil
    headerTitle = nil
    qrCheck = nil
    qrView = nil
    qrSpinner?.stopAnimation(nil)
    qrSpinner = nil
    qrHow = nil
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
