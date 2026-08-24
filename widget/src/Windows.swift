// Window classes and the webview factory.
//
// Both windows are borderless, so both must opt back in to key status —
// a borderless NSWindow/NSPanel refuses it by default, which would leave
// the chat input un-focusable and button focus rings dead.
import AppKit
import WebKit

// A NON-ACTIVATING PANEL, not a plain window — and this is the fix the note
// below predicted.
//
// The popups are .nonactivatingPanel and take key when presented. AppKit then
// swallows the next click on any window that is NOT key purely to activate it,
// so switching between chat, connections and people cost TWO clicks: one
// consumed by activation, one that finally hit the button. It read as the app
// ignoring you.
//
// The comment under this class already worked out the answer while rejecting a
// different one: overriding acceptsFirstMouse on the webview changed mouse
// routing app-wide, and "the move is making WidgetWindow a .nonactivatingPanel
// like the popups already are — clicks reach a nonactivating panel without an
// activation step to swallow them." That is what this is. The style mask is set
// where the window is built; the class just has to be a panel to accept it.
final class WidgetWindow: NSPanel {
  override var canBecomeKey: Bool { true }
  // A desktop widget must never steal main-window status from the work behind
  // it. Key (so the message bar can be typed in) but never main.
  override var canBecomeMain: Bool { false }
}

// NOT HERE: a WKWebView subclass returning true from acceptsFirstMouse.
//
// It was added to fix the collapse arrow needing two taps when the widget was
// not already key — AppKit swallows the click that activates an inactive
// window — and it was backed out the same session because clicks across the
// popups stopped landing at all. Whether it was the cause was never proven;
// what is certain is that it changed mouse routing app-wide to fix an
// occasional second tap, which is a bad trade however it turns out. The page
// side of that bug (widget.js: the arrow collapsing on pointerdown so it
// cannot be hidden out from under the release) is real and stayed.
//
// If the two-tap ever needs fixing again, the move is making WidgetWindow a
// .nonactivatingPanel like the popups already are — clicks reach a
// nonactivating panel without an activation step to swallow them — not
// overriding hit-testing on a webview.

final class PopupPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  // SCREENSHOTTABLE.
  //
  // ⇧⌘4 then space asks the window server for pickable windows, and it skips
  // anything that does not behave like a real window — a borderless
  // non-activating panel that also refuses to become main reads as chrome, so
  // hovering over onboarding selected the desktop behind it instead. Someone
  // could not send a screenshot of the thing they were being asked about.
  //
  // canBecomeMain is what the picker looks at. Saying yes costs nothing here:
  // these panels are modal-ish surfaces the owner is already looking at, and
  // unlike the widget (which must never take main from the work behind it)
  // there is no work behind a full-screen onboarding scrim.
  override var canBecomeMain: Bool { true }
  // AppKit constrains a window's frame so it cannot cover the menu bar. That
  // is right for a document window and wrong for onboarding, which is a scrim
  // over the WHOLE display — constrained, it was handed back the visibleFrame
  // and left an undimmed strip under the menu bar and another above the Dock,
  // with the desktop showing through both.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }
  // ESC is handled in JS (it knows popup state); this is the native backstop.
  override func cancelOperation(_ sender: Any?) { orderOut(nil) }
  // Every way this panel can disappear funnels through orderOut — the page
  // asking, the ESC backstop above, anything native. Onboarding hangs its
  // cleanup here rather than on the page asking nicely, because what it has
  // to undo is the widget being lifted above every window, and a desktop
  // widget stuck on top of the user's work is the worst thing this app could
  // leave behind.
  var willOrderOut: (() -> Void)?
  override func orderOut(_ sender: Any?) {
    willOrderOut?()
    super.orderOut(sender)
  }
}

// Real frosted glass: an NSVisualEffectView blurring what is BEHIND the
// window. CSS backdrop-filter cannot do this — a web page can only blur its
// own content, which is why the chat popup looked flat next to the widget.
// The webview sits transparent on top; the page's rgba background becomes
// the warm char tint over the live blur.
func glassContent(for web: WKWebView, cornerRadius: CGFloat) -> NSView {
  let effect = NSVisualEffectView()
  effect.material = .hudWindow
  effect.blendingMode = .behindWindow
  effect.state = .active // stay blurred even when the panel isn't key
  effect.wantsLayer = true
  effect.layer?.cornerRadius = cornerRadius
  effect.layer?.masksToBounds = true
  effect.addSubview(web)
  return effect
}

// Every webview is built the same way: nonpersistent storage, the bridge as
// its only message handler, file-URL navigation only, transparent background.
// The pages carry a `default-src 'none'` CSP; this factory is the second
// fence — even a rogue <a href> cannot leave file: space.
// The ear webview: same bridge, but a custom-scheme origin so the voice
// stack's root-relative asset fetches (/models/…, /vendor/…) resolve
// through AssetSchemeHandler, and a UI delegate that grants the microphone
// to our own page (the macOS TCC prompt still gates the first use).
func makeEarWebView(bridge: Bridge) -> WKWebView {
  let config = WKWebViewConfiguration()
  config.websiteDataStore = .nonPersistent()
  config.userContentController.add(bridge, name: "hz")
  config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: AssetSchemeHandler.scheme)
  // The ear page is hidden and never receives a user gesture, so without
  // this WebKit keeps its AudioContext suspended and Kokoro plays silence.
  // The gesture requirement is waived for THIS page only; the visible pages
  // don't play media at all.
  config.mediaTypesRequiringUserActionForPlayback = []

  let web = WKWebView(frame: .zero, configuration: config)
  web.navigationDelegate = bridge
  web.uiDelegate = bridge
  web.setValue(false, forKey: "drawsBackground")
  // Identity for the bridge's capability check (Bridge.pageCapabilities).
  bridge.register(web, as: "ear")
  web.load(URLRequest(url: URL(string: "\(AssetSchemeHandler.scheme)://app/ear.html")!))
  return web
}

func makeWebView(bridge: Bridge, page: String) -> WKWebView {
  let config = WKWebViewConfiguration()
  config.websiteDataStore = .nonPersistent()
  config.userContentController.add(bridge, name: "hz")
  // NO WRITING TOOLS — and it is the page that has to say so, not this file.
  // WKWebViewConfiguration.writingToolsBehavior exists, but its header is
  // gated behind __MAC_OS_X_VERSION_MIN_REQUIRED >= 150000 and build.sh pins
  // this binary to macOS 13.0 on purpose, so the symbol is not declared and
  // the code does not compile. Reaching it through KVC would mean a raw enum
  // value and an unknown-key exception that Swift cannot catch, on a widget
  // that is meant to sit on the desktop for weeks.
  // widget.html carries writingsuggestions="false" instead, which is the
  // standard control and needs no deployment-target change. If "Write with
  // Siri" ever reappears over the message bar, THIS is the trade to revisit:
  // raising the floor to macOS 15 would drop 13 and 14.

  let web = WKWebView(frame: .zero, configuration: config)
  web.navigationDelegate = bridge
  // KVC is the sanctioned spelling for a transparent WKWebView on macOS.
  web.setValue(false, forKey: "drawsBackground")

  guard let ui = Bundle.main.resourceURL?.appendingPathComponent("ui") else {
    fatalError("widget bundle has no Resources/ui")
  }
  // Identity for the bridge's capability check (Bridge.pageCapabilities). The
  // page name is the one the caller asked for, not one read back off the view.
  bridge.register(web, as: page)
  web.loadFileURL(ui.appendingPathComponent("\(page).html"), allowingReadAccessTo: ui)
  return web
}
