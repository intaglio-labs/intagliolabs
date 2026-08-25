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

// THE CLICK THAT LANDS THE FIRST TIME.
//
// This is the subclass the note here used to forbid. It is back because the two
// beliefs that kept it out have now been MEASURED with compiled probes rather
// than reasoned about, and both were wrong. The old note is rewritten instead of
// argued with, but the history it recorded is kept below, because it is the
// reason to be careful here.
//
// WHAT WAS MEASURED (2026-08-24):
//   • WKWebView.needsPanelToBecomeKey == true. That makes
//     NSPanel.becomesKeyOnlyIfNeeded INERT for every window in this app -- the
//     flag only withholds key when the clicked view says it does not need it,
//     and a webview always says it does. So the recommendation this note used to
//     make (make WidgetWindow a nonactivating panel) was tried, then extended
//     with that flag, and neither could ever have worked. The nonactivating
//     style mask removes the app-ACTIVATION step; the window-KEY step is a
//     separate one, and it is the one eating the click.
//   • WKWebView.acceptsFirstMouse == false, so the key-acquiring click is
//     discarded rather than delivered. This override is the only lever on that.
//   • The override is ADDITIVE, not substitutive: the window still takes key,
//     the click is ALSO delivered. On a window that is already key AppKit never
//     calls acceptsFirstMouse at all, so this cannot change any click except the
//     first one into a non-key window.
//   • It does not break dragging. It is a PRECONDITION for first-click dragging;
//     without it a press on a non-key panel produces no mouseDown at all.
//
// WHAT HAPPENED LAST TIME, and why that is not a reason to stay out. The version
// backed out on 2026-08-21 was the same two lines, applied at the same single
// place -- this factory -- and the revert said "clicks across the popups stopped
// landing at all", while conceding in its own words that "whether it was the
// cause is not proven". A day later a different commit found that every
// pressable carried an `:active` transform of scale(1.10, 0.91), and that a
// transform moves the HIT BOX with the pixels, so an edge press slipped off the
// element before release and neither click nor pointerup fired. Those rules were
// byte-identical before, during and after the acceptsFirstMouse window, they
// affected exactly the popup controls, and they were not fixed until 2026-08-22.
// That is a documented, sufficient explanation for the symptom this override was
// blamed for, and it is fixed.
//
// So: same override, same site, applied knowingly rather than hopefully. If
// clicks across the popups ever stop landing again, this is still the first
// thing to suspect -- but suspect it with a bisect, not with a memory.
//
// ONE REAL BEHAVIOUR CHANGE, and it is intended: a control now ACTS on the click
// that focuses its window instead of only focusing it. Click the size slider in
// a popup that is not key and the slider moves, where before the press was
// swallowed. That is what every already-key window in macOS does, and it is what
// "my clicks should land" asks for.
final class ClickThroughWebView: WKWebView {
  // No super call, deliberately: NSView's implementation returns false, and
  // WKWebView does not override it. There is nothing to defer to.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

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

  let web = ClickThroughWebView(frame: .zero, configuration: config)
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
