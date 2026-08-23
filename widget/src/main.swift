// Hazlie desktop widget — entry point and window wiring.
//
// One process, no Dock icon (.accessory), three windows: the desktop-pinned
// widget panel plus two popups. All HTTP lives in Bridge.swift; this file
// owns windows and nothing else.
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, BridgeDelegate {
  // Every window size in this file is one of these times Bridge.scale. They
  // are the 1.0 sizes and the only place a literal belongs — a size written
  // anywhere else stops scaling the moment the slider moves.
  // How far the widget's right edge sits from the right edge of the screen.
  // The widget is PINNED there: it is a desktop widget, it lives in that
  // corner, and resizing must not walk it out of it.
  private static let edgeInset: CGFloat = 24

  // Height carries 16px of bottom padding for the gear's drop shadow —
  // body.widget in palette.css buys the same room; change both together.
  private static let widgetBase = NSSize(width: 312, height: 114)
  private static let chatBase = NSSize(width: 420, height: 560)
  // Height is a low FLOOR now, not a reservation: the connections page reports
  // its real content height (hzAutoFit on .conn-main), so the card fits snugly
  // instead of standing 500px tall with the shelf pinned to the bottom.
  private static let connectionsBase = NSSize(width: 312, height: 150)
  private static let peopleBase = NSSize(width: 312, height: 300)
  private static let skyBase = NSSize(width: 520, height: 620)

  private let bridge = Bridge()
  private var widgetWindow: WidgetWindow!
  private var widgetWeb: WKWebView!
  private var chatPanel: PopupPanel?
  private var chatWeb: WKWebView?
  private var connectionsPanel: PopupPanel?
  private var peoplePanel: PopupPanel?
  private var skyPanel: PopupPanel?
  private var onboardingPanel: PopupPanel?
  private var earWeb: WKWebView?
  // Messages submitted (typed or spoken) before the chat page is alive, in
  // arrival order. The chatReady handshake takes the first; the bridge pulls
  // each of the rest after the previous ask settles, so every queued message
  // stays its own ask — never glued into one.
  private var pendingUtterances: [String] = []
  // A voice failure raised before the chat page is alive; same handshake.
  private var pendingVoiceNote: String?

  func applicationDidFinishLaunching(_ note: Notification) {
    bridge.delegate = self
    installEditMenu()

    // Self-contained install: on a fresh Mac the local backend isn't set up,
    // so stand it up from the bundle. On a machine that already has it (the
    // owner's repo-based setup, or a prior run) this only regenerates a
    // missing secret file, and it runs off the main thread so it never
    // delays the UI.
    Provision.ensureBackend()

    // The second half of the self-move (Bridge "moveToApplications"): the
    // old instance could not delete the bundle it was running from, so it
    // left the path behind for us. Guards, because this deletes a directory:
    // only ever a path ending in Hazlie.app, never the copy now running, and
    // only once this instance really is in /Applications.
    if let stale = UserDefaults.standard.string(forKey: "HazlieStaleCopyPath") {
      UserDefaults.standard.removeObject(forKey: "HazlieStaleCopyPath")
      if stale.hasSuffix("/Intaglio Labs.app"),
         stale != Bundle.main.bundlePath,
         Bundle.main.bundlePath.hasPrefix("/Applications/") {
        try? FileManager.default.removeItem(atPath: stale)
      }
    }

    widgetWeb = makeWebView(bridge: bridge, page: "widget")
    let scale = Bridge.scale
    let w = WidgetWindow(
      contentRect: NSRect(origin: .zero, size: Self.scaled(Self.widgetBase, scale)),
      styleMask: [.borderless], backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    // Elements float on the wallpaper; a window shadow would draw one blob
    // around their union.
    w.hasShadow = false
    // Desktop-pinned: above wallpaper and desktop icons, below every normal
    // window. This is the macOS-widget stacking the owner asked for — the
    // widget never covers work. Fallback if icon stacking misbehaves on a
    // future OS: kCGDesktopWindowLevel + 1.
    w.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    // Every Space, stays put through Mission Control, never in the Cmd-` cycle.
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    w.contentView = widgetWeb
    // Bottom-right of the main screen, off the Dock. Used on first launch and
    // whenever a restored frame would not be reachable.
    func placeBottomRight() {
      guard let v = NSScreen.main?.visibleFrame else { return }
      w.setFrameOrigin(NSPoint(x: v.maxX - w.frame.width - Self.edgeInset, y: v.minY + 24))
    }

    if w.setFrameUsingName("HazlieWidget") {
      // A RESTORED FRAME IS NOT NECESSARILY A REACHABLE ONE. The autosaved
      // origin is in global screen coordinates, so a frame saved on a monitor
      // that is now disconnected — or on a display whose arrangement changed —
      // restores the widget somewhere nobody can drag it back from. It has no
      // title bar and macOS does not rescue borderless windows.
      //
      // Reachable means: enough of it overlaps a screen to grab. Anything less
      // goes back to the corner it started in.
      let f = w.frame
      let onSomeScreen = NSScreen.screens.contains { screen in
        let hit = screen.visibleFrame.intersection(f)
        return hit.width >= 80 && hit.height >= 40
      }
      if !onSomeScreen { placeBottomRight() }
    } else {
      placeBottomRight()
    }
    // Force the current height even when frame autosave restores an older
    // one — the caption strip went and it shrank to 122, the trinket shelf
    // landed and it grew to 150, the shelf was cut for a settings gear and it
    // fell to 68, then the gear moved to its own row under the orb and it came
    // back to 98. Autosave remembers whichever came last, so this line is what
    // keeps a long-running install from reopening at a stale height.
    // NAME FIRST, THEN PIN — the order matters. AppKit only persists frame
    // changes made after the autosave name is set, so pinning first left the
    // stale frame in defaults: the window was in the right place and the
    // saved copy still said otherwise, which is the kind of disagreement that
    // shows up two launches later.
    w.setFrameAutosaveName("HazlieWidget")
    // Re-pin on every launch, not only on resize. The autosaved frame is
    // wherever the window last happened to be, and the version of this that
    // let the widget wander sideways is exactly what wrote the frame being
    // restored here.
    w.setFrame(Self.pinnedFrame(w, scale), display: false)
    w.orderFrontRegardless()
    widgetWindow = w

    // The ear: a hidden, zero-size webview kept INSIDE the widget window so
    // WebKit doesn't throttle its timers or its capture session. It stays a
    // light empty page until the first arm; models load lazily then.
    let ear = makeEarWebView(bridge: bridge)
    ear.frame = .zero
    w.contentView?.addSubview(ear)
    earWeb = ear

    // A wake from sleep is the moment status is most likely stale.
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.widgetWeb.evaluateJavaScript("window.__hzWake && window.__hzWake()")
    }

    // First launch shows the welcome flow. Only completing it sets the flag,
    // so a dismissed flow comes back — and the settings button reopens it on
    // demand regardless.
    if !Bridge.onboarded {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.openOnboarding()
      }
    }

    // Dev affordance: open a popup at launch so panel work is verifiable
    // without a human click. No effect unless the variable is set.
    switch ProcessInfo.processInfo.environment["HAZLIE_OPEN"] {
    case "chat": openChat()
    case "connections": openConnections()
    case "onboarding": openOnboarding()
    default: break
    }
    // Dev affordance: arm the ear shortly after launch, exercising the
    // provisioning fail-closed path end to end without a click.
    if ProcessInfo.processInfo.environment["HAZLIE_DEBUG_ARM"] == "1" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
        self?.armVoice()
      }
    }
  }

  // ⌘V, ⌘C, ⌘X, ⌘A in the message bar and the chat.
  //
  // This app is LSUIElement/.accessory, so it has no menu bar — and the
  // clipboard shortcuts are not built into text fields, they are KEY
  // EQUIVALENTS ON EDIT MENU ITEMS. No menu, no key equivalents: typing
  // reached the focused field fine and ⌘V did nothing, which reads as the
  // field being broken rather than as a missing menu.
  //
  // An accessory app never DISPLAYS this, so it costs nothing on screen; it
  // exists purely so the responder chain has somewhere to resolve the
  // shortcuts. Nil targets on purpose — that is what makes each item route to
  // whatever is first responder, which is the webview holding the caret.
  private func installEditMenu() {
    let edit = NSMenu(title: "Edit")
    let items: [(String, Selector, String)] = [
      ("Undo", Selector(("undo:")), "z"),
      ("Redo", Selector(("redo:")), "Z"),
      ("Cut", #selector(NSText.cut(_:)), "x"),
      ("Copy", #selector(NSText.copy(_:)), "c"),
      ("Paste", #selector(NSText.paste(_:)), "v"),
      ("Select All", #selector(NSText.selectAll(_:)), "a"),
    ]
    for (title, action, key) in items {
      edit.addItem(NSMenuItem(title: title, action: action, keyEquivalent: key))
    }
    let editItem = NSMenuItem()
    editItem.submenu = edit
    let main = NSMenu()
    main.addItem(NSMenuItem()) // slot 0 is the app menu; AppKit expects one
    main.addItem(editItem)
    NSApp.mainMenu = main
  }

  // MARK: popups

  private func makePanel(page: String, size rawSize: NSSize, glass: Bool = false) -> PopupPanel {
    let size = Self.fit(rawSize, on: widgetWindow)
    let web = makeWebView(bridge: bridge, page: page)
    let p = PopupPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .normal
    p.collectionBehavior = [.moveToActiveSpace]
    p.isFloatingPanel = false
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.appearance = NSAppearance(named: .darkAqua) // design is dark-only
    if glass {
      let effect = glassContent(for: web, cornerRadius: 20)
      p.contentView = effect
      // Frame the webview AFTER the effect view has its window size — an
      // autoresizing mask from a zero frame stays zero forever.
      web.frame = effect.bounds
      web.autoresizingMask = [.width, .height]
    } else {
      p.contentView = web
    }
    return p
  }

  // Where a popup goes: above the widget, right edges aligned, clamped
  // on-screen. Pulled out of `present` because a popup that is already open
  // has to be re-placed when the size changes — resizing an NSWindow keeps
  // its bottom-LEFT corner, so a popup that grows or shrinks while visible
  // walks its right edge away from the widget's, which is the edge both of
  // them are pinned to.
  private func placedFrame(_ size: NSSize) -> NSRect {
    let wf = widgetWindow.frame
    let screen = widgetWindow.screen ?? NSScreen.main
    var origin = NSPoint(x: wf.maxX - size.width, y: wf.maxY + Self.popupGap)
    if let v = screen?.visibleFrame {
      origin.x = max(v.minX + 12, min(origin.x, v.maxX - size.width - 12))
      if origin.y + size.height > v.maxY - 12 {
        origin.y = v.maxY - size.height - 12
      }
      origin.y = max(v.minY + 12, origin.y)
    }
    return NSRect(origin: origin, size: size)
  }

  // ONE window operation, not two. setContentSize followed by setFrameOrigin
  // is two separate trips to the window server, and at the rate a drag
  // produces them the intermediate state is on screen long enough to see: the
  // popup grew downward over the widget and then jumped back up.
  private func resize(_ panel: PopupPanel, to size: NSSize) {
    let frame = placedFrame(size)
    guard frame != panel.frame else { return }
    panel.setFrame(frame, display: false)
  }

  private func place(_ panel: PopupPanel) {
    panel.setFrame(placedFrame(panel.frame.size), display: false)
  }

  private func present(_ panel: PopupPanel) {
    place(panel)
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  // Onboarding is not a window in the way the others are: it covers the whole
  // display and dims it, and its content floats on that scrim. So it takes the
  // screen's FULL frame — not visibleFrame, which stops at the menu bar and
  // the Dock and would leave two undimmed strips — and sits above ordinary
  // windows rather than at .normal with the popovers.
  //
  // hasShadow off: makePanel turns it on for popovers, and a shadow around a
  // full-screen rectangle is a dark band down the edge of the display.
  func openOnboarding() {
    // Opening the flow IS pretending this is a fresh install — the owner's
    // rule: replay behaves like the first time, every time. So the flag
    // drops, and only FINISHING sets it back; escape mid-replay and the flow
    // returns at next launch, exactly as a dismissed first run does. On the
    // real first launch this is already false and the line is a no-op.
    Bridge.onboarded = false
    // Replay is a fresh install, so the hand-holds rewind with it: every
    // connector walks the user through again on its next first press.
    Bridge.handheld = []
    // The widget LEAVES for the flow's duration. It used to sit under the
    // scrim, faintly visible through the dim — which made scene 3's reveal a
    // "notice the thing you half-saw" instead of a meeting. Hidden here,
    // brought back by scene 3's spotlight, and guaranteed back by the
    // panel's own orderOut hook whatever route the flow leaves by.
    widgetWindow.orderOut(nil)
    let screen = widgetWindow.screen ?? NSScreen.main
    let frame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    if onboardingPanel == nil {
      // Size passed through makePanel is a placeholder — the real frame is
      // set below and is the full screen, which is bigger than anything
      // makePanel's screen-fit would allow. Onboarding is the one window here
      // that is meant to be exactly as large as the display.
      let p = makePanel(page: "onboarding", size: frame.size)
      p.hasShadow = false
      p.level = .floating
      // Whatever route the flow leaves by, the widget goes back under the
      // windows — see PopupPanel.willOrderOut.
      p.willOrderOut = { [weak self] in
        self?.spotlightWidget(false)
        // ...and the widget comes back however the flow ended — finished,
        // escaped from scene 1, or the panel closed by any native path. At
        // its own level: below every window, exactly as it lives.
        self?.widgetWindow.orderFrontRegardless()
        // The handoff: a FINISHED flow (and only a finished one — escape
        // leaves onboarded false) sets the gear bouncing until settings is
        // opened once. The next scene is behind that gear, and the nudge is
        // this app's one gesture for "this wants you".
        if Bridge.onboarded && !Bridge.connectorsIntroDone {
          self?.widgetWeb?.evaluateJavaScript("window.__hzGearNudge && window.__hzGearNudge(true)")
        }
      }
      onboardingPanel = p
    }
    guard let p = onboardingPanel else { return }
    // Re-set every time: the display can change between one showing and the
    // next, and a stale frame would dim the wrong rectangle.
    p.setFrame(frame, display: false)
    // And rewind the flow. The panel and its page are both reused, so without
    // this, reopening from settings resumes on whatever screen it was last
    // abandoned on rather than on the welcome. Guarded because on the very
    // first open the page has not finished loading yet — which is harmless,
    // since a freshly loaded page already starts on screen 1.
    (p.contentView as? WKWebView)?
      .evaluateJavaScript("window.__hzOnboardingReset && window.__hzOnboardingReset()")
    NSApp.activate(ignoringOtherApps: true)
    p.makeKeyAndOrderFront(nil)
  }

  func openChat() {
    if chatPanel == nil {
      // No glass, no box: the chat is transparent and its elements float
      // directly on the wallpaper. Window shadow off — AppKit would draw
      // one blob around the union of the floating pieces.
      let web = makeWebView(bridge: bridge, page: "chat")
      let p = PopupPanel(
        contentRect: NSRect(origin: .zero, size: capped(Self.fit(Self.scaled(Self.chatBase, Bridge.scale), on: widgetWindow))),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = false
      p.level = .normal
      p.collectionBehavior = [.moveToActiveSpace]
      p.isFloatingPanel = false
      p.hidesOnDeactivate = false
      p.isReleasedWhenClosed = false
      p.appearance = NSAppearance(named: .darkAqua)
      p.contentView = web
      chatPanel = p
      chatWeb = web
    }
    present(chatPanel!)
  }

  func openChat(with utterance: String) {
    if chatPanel != nil, let web = chatWeb {
      // The panel existing does not mean chat.js has finished loading —
      // __hzIncoming is defined late. Probe for it: a not-yet-loaded page
      // answers false and the message falls back to the chatReady handshake,
      // instead of a ReferenceError swallowed by the nil completion handler.
      // Queued (not string-joined) so a message already waiting on the
      // handshake and this one each stay their own ask — and a queued voice
      // transcript keeps its exact text for the bridge's voice-turn match.
      let js = "window.__hzIncoming ? (window.__hzIncoming(\(jsString(utterance))), true) : false"
      web.evaluateJavaScript(js) { [weak self] result, _ in
        guard let self, (result as? Bool) != true else { return }
        self.pendingUtterances.append(utterance)
      }
    } else {
      pendingUtterances.append(utterance)
    }
    openChat()
  }

  // Pops ONE queued message per call — the chatReady handshake and the
  // bridge's after-ask drain each take the next in line.
  func takePendingUtterance() -> String {
    guard !pendingUtterances.isEmpty else { return "" }
    return pendingUtterances.removeFirst()
  }

  func takePendingVoiceNote() -> String {
    let n = pendingVoiceNote ?? ""
    pendingVoiceNote = nil
    return n
  }

  private func eval(_ web: WKWebView?, _ js: String) {
    DispatchQueue.main.async { web?.evaluateJavaScript(js, completionHandler: nil) }
  }

  private func jsString(_ s: String) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: [s]),
          let arr = String(data: d, encoding: .utf8) else { return "\"\"" }
    return "\(arr)[0]"
  }

  // MARK: voice

  func armVoice() {
    eval(earWeb, "window.__earArm && window.__earArm()")
  }

  func voiceTranscript(_ utterance: String) {
    openChat(with: utterance) // same path as the typed bar; chat renders it
  }

  func voiceNote(_ message: String) {
    if chatPanel != nil, let web = chatWeb {
      eval(web, "window.__hzVoiceNote && window.__hzVoiceNote(\(jsString(message)))")
      present(chatPanel!)
    } else {
      pendingVoiceNote = message
      openChat()
    }
  }

  func setOrbTalking(_ talking: Bool) {
    eval(widgetWeb, "window.__hzOrb && window.__hzOrb(\(talking))")
  }

  // Named face, straight through. Safe to interpolate: Bridge.orbFaces has
  // already checked this string against a fixed allow-list.
  func setOrbFace(_ face: String) {
    eval(widgetWeb, "window.__hzOrbState && window.__hzOrbState('\(face)')")
  }

  func speakAnswer(_ text: String) {
    eval(earWeb, "window.__earSpeak && window.__earSpeak(\(jsString(text)))")
  }

  func openConnections() {
    // The gear has been pressed (or settings opened some other way): the
    // nudge's job is done either way.
    widgetWeb?.evaluateJavaScript("window.__hzGearNudge && window.__hzGearNudge(false)")
    // The gear TOGGLES (owner, 2026-08-22): pressing it with settings
    // already up puts settings away. Visibility, not existence — the panel
    // is kept around hidden after its first close.
    if let p = connectionsPanel, p.isVisible {
      p.orderOut(nil)
      return
    }
    let firstOpen = connectionsPanel == nil
    if connectionsPanel == nil {
      // No wider than the widget itself; tall enough that every current
      // connection is visible without scrolling — the owner's constraints.
      connectionsPanel = makePanel(page: "connections", size: capped(Self.scaled(Self.connectionsBase, Bridge.scale)))
      connectionsPanel!.hasShadow = false
    }
    present(connectionsPanel!)
    // Tell the page whether this open is the guided one. On the panel's very
    // first open the page is still loading and PULLS the same fact from
    // prefs instead — pushing here would race the load and lose.
    if !firstOpen {
      let intro = Bridge.onboarded && !Bridge.connectorsIntroDone
      (connectionsPanel?.contentView as? WKWebView)?
        .evaluateJavaScript("window.__hzConnectorsIntro && window.__hzConnectorsIntro(\(intro))")
    }
  }

  // The People popup — the door into the who's-who / person-index feature.
  // Toggles like the gear (press again to dismiss); reuses the same panel
  // machinery, kept lazily so it survives a close hidden rather than rebuilt.
  func openPeople() {
    if let p = peoplePanel, p.isVisible {
      p.orderOut(nil)
      return
    }
    if peoplePanel == nil {
      peoplePanel = makePanel(page: "people", size: capped(Self.scaled(Self.peopleBase, Bridge.scale)))
      peoplePanel!.hasShadow = false
    }
    present(peoplePanel!)
  }

  // The constellation is its own popup (owner: a standalone star-field, not a
  // column inside People). Toggles like the others; the page's own close
  // routes here via closeWindow. Bigger base because it is a star-field.
  func openSky() {
    if let p = skyPanel, p.isVisible {
      p.orderOut(nil)
      return
    }
    if skyPanel == nil {
      skyPanel = makePanel(page: "people-sky", size: capped(Self.scaled(Self.skyBase, Bridge.scale)))
      skyPanel!.hasShadow = false
    }
    present(skyPanel!)
  }

  // What each popup's page last said it needs, in CSS px — unscaled, because
  // the scale can change afterwards and the measurement is about content, not
  // about how big it is being drawn.
  private var contentHeights: [PopupPanel: CGFloat] = [:]
  // Extra width past the base, same CSS-px convention. Only the connections
  // page sets this today (its hint strip opens as a side section).
  private var extraWidths: [PopupPanel: CGFloat] = [:]

  private func capped(_ size: NSSize) -> NSSize {
    NSSize(width: size.width, height: min(size.height, popupCeiling()))
  }

  func fitPopup(_ webView: WKWebView, contentHeight: Double, extraWidth: Double) {
    // Either dimension may arrive alone: height 0 means "keep what you had"
    // (the hint panel opening posts only extraWidth), extraWidth < 0 likewise
    // (every hzAutoFit height report posts no width at all).
    guard contentHeight > 0 || extraWidth >= 0 else { return }
    // Remember it, but do not act on it mid-drag: the height a page reports
    // while the scale is moving is a measurement of a layout that is about to
    // change again, and acting on it is what turned one drag into a stream of
    // window resizes.
    if scaleDragging {
      for (panel, _) in [(connectionsPanel, 0), (chatPanel, 0), (peoplePanel, 0), (skyPanel, 0)] {
        guard let p = panel, p.contentView === webView
          || p.contentView?.subviews.first === webView else { continue }
        if contentHeight > 0 { contentHeights[p] = CGFloat(contentHeight) }
        if extraWidth >= 0 { extraWidths[p] = CGFloat(extraWidth) }
        return
      }
      return
    }
    let panels: [(PopupPanel?, NSSize)] = [
      (connectionsPanel, Self.connectionsBase), (chatPanel, Self.chatBase),
      (peoplePanel, Self.peopleBase), (skyPanel, Self.skyBase),
    ]
    for (panel, base) in panels {
      guard let p = panel, p.contentView === webView
        || p.contentView?.subviews.first === webView else { continue }
      if contentHeight > 0 { contentHeights[p] = CGFloat(contentHeight) }
      if extraWidth >= 0 { extraWidths[p] = CGFloat(extraWidth) }
      let want = NSSize(
        width: base.width + (extraWidths[p] ?? 0),
        height: max(base.height, contentHeights[p] ?? 0))
      let size = capped(Self.fit(Self.scaled(want, Bridge.scale), on: p))
      guard abs(size.height - p.frame.height) > 1
        || abs(size.width - p.frame.width) > 1 else { return } // no thrash
      resize(p, to: size)
      return
    }
  }

  // MARK: the last onboarding scene

  // The widget's rectangle expressed inside the onboarding window, in
  // fractions. Fractions rather than points because the page is zoomed and
  // does not know by how much; a fraction of innerWidth survives that.
  func widgetSpot() -> [String: Double] {
    guard let panel = onboardingPanel else { return [:] }
    let w = widgetWindow.frame
    let p = panel.frame
    guard p.width > 0, p.height > 0 else { return [:] }
    return [
      "x": Double((w.minX - p.minX) / p.width),
      // Flipped: AppKit measures up from the bottom, CSS down from the top.
      "y": Double((p.maxY - w.maxY) / p.height),
      "w": Double(w.width / p.width),
      "h": Double(w.height / p.height),
    ]
  }

  // The last scene points at the REAL widget rather than a picture of one, so
  // for the length of it the widget comes up above the scrim. Otherwise it is
  // pinned below every window — which is the very thing the scene exists to
  // explain — and would be under the dim with everything else.
  //
  // Raising it beats cutting a hole in the scrim: a hole shows whatever
  // happens to be topmost under the onboarding panel at that point, which is
  // the widget only if no other window is in the way.
  private var widgetLevelBeforeSpotlight: NSWindow.Level?
  func spotlightWidget(_ on: Bool) {
    if on {
      // BE VISIBLE FIRST. A frame restored from a different-sized display — a
      // second monitor, or a remote desktop smaller than the Mac it was saved
      // on — can sit partly off this screen's bottom-right, and scene 3 would
      // then ring a widget that's cut off (owner, testing on remote desktop).
      // If it doesn't fully fit the current screen, pull it back into the
      // bottom-right corner; if it already fits, leave it where the owner put
      // it. This makes the "where it lives" scene point at a whole widget on
      // any screen size.
      if let v = (widgetWindow.screen ?? NSScreen.main)?.visibleFrame {
        var f = widgetWindow.frame
        if !v.contains(f) {
          f.origin.x = v.maxX - f.width - Self.edgeInset
          f.origin.y = max(v.minY + 24, min(f.origin.y, v.maxY - f.height))
          widgetWindow.setFrame(f, display: true)
        }
      }
      if widgetLevelBeforeSpotlight == nil { widgetLevelBeforeSpotlight = widgetWindow.level }
      // One above onboarding's .floating, so it clears the scrim and nothing
      // else does.
      widgetWindow.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
      widgetWindow.orderFrontRegardless()
    } else if let previous = widgetLevelBeforeSpotlight {
      widgetWindow.level = previous
      widgetLevelBeforeSpotlight = nil
    }
  }

  func closeWindow(of webView: WKWebView) {
    // The restore rides on orderOut itself (PopupPanel.willOrderOut), so it
    // does not matter which of the several exits from onboarding was taken.
    webView.window?.orderOut(nil)
  }

  func dragWindow(of webView: WKWebView) {
    guard let win = webView.window, let event = NSApp.currentEvent else { return }
    // The popups drag freely; the WIDGET only slides up and down.
    //
    // performDrag is a 2D drag with no axis constraint, so the widget gets a
    // hand-rolled tracking loop instead. Its x is not the user's to set — it
    // is pinned to the right edge of the screen, and every other part of this
    // app (popup placement, the onboarding spotlight, resize) is computed
    // from that pin. A widget dragged left would silently break all of them.
    guard win === widgetWindow else {
      win.performDrag(with: event)
      return
    }
    let startMouse = NSEvent.mouseLocation
    let startFrame = win.frame
    let bounds = (win.screen ?? NSScreen.main)?.visibleFrame
    // A modal event loop, the same shape performDrag uses internally: it
    // owns the mouse until the button comes up and cannot outlive the drag.
    while let e = win.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
      if e.type == .leftMouseUp { break }
      var frame = startFrame
      frame.origin.y = startFrame.origin.y + (NSEvent.mouseLocation.y - startMouse.y)
      if let v = bounds {
        // Never draggable off the top or under the Dock.
        frame.origin.y = max(v.minY, min(frame.origin.y, v.maxY - frame.height))
      }
      win.setFrame(frame, display: true)
    }
    // The autosave name is set at launch, so the resting place persists on
    // its own — but the popups are positioned against the widget and are
    // placed on open, so nothing else needs telling.
    win.saveFrame(usingName: "HazlieWidget")
  }

  // Push the Reduce Motion override into every live page so the orb and the
  // thinking dots change the moment the switch is flipped, rather than at the
  // next launch. Pages that have not loaded yet pick it up from `prefs`.
  func motionAnywayChanged(_ on: Bool) {
    let js = "window.__hzMotion && window.__hzMotion(\(on))"
    widgetWeb?.evaluateJavaScript(js)
    chatWeb?.evaluateJavaScript(js)
  }

  private static func scaled(_ size: NSSize, _ s: Double) -> NSSize {
    NSSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
  }

  // THE HARD CONSTRAINT: no window this app opens may be larger than the
  // space it has to open in. Without it the size slider is a way to make the
  // UI unusable — at 160% the settings popup is 780pt tall, which does not
  // fit above a widget on a 949pt screen, and everything below the fold is
  // simply gone. Clamping means the top of the range degrades to "as big as
  // it can be" instead of to "broken".
  private static let screenMargin: CGFloat = 16
  private static func fit(_ size: NSSize, on window: NSWindow?) -> NSSize {
    guard let v = (window?.screen ?? NSScreen.main)?.visibleFrame else { return size }
    return NSSize(
      width: min(size.width, v.width - screenMargin * 2),
      height: min(size.height, v.height - screenMargin * 2))
  }

  // How tall a popup may be before it stops fitting ABOVE the widget.
  //
  // Clamping to the screen was not enough, and the way it failed is worth
  // keeping: a popup taller than the gap above the widget still fitted the
  // screen, so `place` did its job and slid it down to stay on — straight
  // over the widget. The popup and the widget are separate windows with
  // nothing between them, so "on screen" was never the constraint. This is.
  private func popupCeiling() -> CGFloat {
    guard let v = (widgetWindow.screen ?? NSScreen.main)?.visibleFrame else {
      return .greatestFiniteMagnitude
    }
    let room = v.maxY - Self.screenMargin - (widgetWindow.frame.maxY + Self.popupGap)
    // If the widget has been dragged high enough that there is no usable room
    // above it, overlap is unavoidable and a popup squeezed to 200pt would be
    // useless anyway. Fall back to the screen and let `place` sort it out.
    return room >= 240 ? room : .greatestFiniteMagnitude
  }
  private static let popupGap: CGFloat = 12

  // The widget's frame at a given scale: right edge against the screen's right
  // edge, bottom edge wherever it already was, clamped so a tall widget near
  // the bottom cannot end up under the Dock.
  private static func pinnedFrame(_ window: NSWindow, _ scale: Double) -> NSRect {
    let size = fit(scaled(widgetBase, scale), on: window)
    var frame = NSRect(origin: window.frame.origin, size: size)
    guard let v = (window.screen ?? NSScreen.main)?.visibleFrame else { return frame }
    frame.origin.x = v.maxX - size.width - edgeInset
    frame.origin.y = max(v.minY + 24, min(frame.origin.y, v.maxY - size.height))
    return frame
  }

  // Resize everything to match the slider. Two halves, and both are needed:
  // pageZoom scales what is DRAWN, the frame changes scale what it is drawn
  // INTO. Zoom alone would magnify the layout inside a window that had not
  // grown and clip it; a bigger window alone would leave the same small
  // widget floating in a bigger transparent rectangle.
  //
  // FIRST-LOAD zoom is not here — it is Bridge's didFinish, because pageZoom
  // is reset by navigation and every window in this file is built from a
  // webview that is already loading. This method is the LIVE case only.
  //
  // pageZoom also means no page needs a single line about scale: the CSS
  // viewport shrinks by exactly the zoom factor, so a 312pt-wide layout stays
  // 312 CSS px whatever the slider says, and every px in palette.css keeps
  // meaning what it meant.
  // True while the size slider is being dragged. The page that owns the
  // slider asks for a live preview on every step and commits on release; in
  // between, a popup measuring itself and asking to be resized is measuring a
  // moving target, and the two of them chase each other for the length of the
  // drag.
  private var scaleDragging = false

  func scaleChanged(_ scale: Double, committed: Bool, from webView: WKWebView?) {
    scaleDragging = !committed
    // ONLY THE SIZE CHANGES. The widget is pinned to the right edge of the
    // screen and grows LEFT and UP from its bottom-right corner: left because
    // that edge is pinned, up because the other way is the Dock.
    //
    // The first version anchored the top-left instead, which meant every
    // change walked the widget sideways — bigger pushed it off the right edge
    // and into a clamp, smaller left it stranded in the middle. Nothing about
    // a size control should move anything.
    // display: false, not true. This runs on every tick of a drag, and
    // forcing a synchronous redraw of the window AND a full relayout of three
    // zoomed pages per tick is what made the first pull of the slider stutter.
    // AppKit redraws on the next cycle regardless.
    widgetWindow.setFrame(Self.pinnedFrame(widgetWindow, scale), display: false)
    widgetWeb.pageZoom = scale

    for (panel, base) in [
      (chatPanel, Self.chatBase),
      (connectionsPanel, Self.connectionsBase),
    ] {
      guard let p = panel else { continue }
      // THE WINDOW THAT OWNS THE SLIDER DOES NOT MOVE UNDER THE SLIDER.
      // Resizing it mid-drag changes the track's length and the panel's
      // position in the same frame, so the thumb slides out from under the
      // cursor and the value jumps — dragging fought back. The widget still
      // resizes live, which is the thing actually being sized; this one
      // catches up on release.
      let owner = p.contentView === webView || p.contentView?.subviews.first === webView
      if !committed && owner { continue }
      // The page may have told us it needs more height than the base; keep
      // that, scaled, rather than snapping back to the guess.
      let want = NSSize(width: base.width, height: max(base.height, contentHeights[p] ?? 0))
      resize(p, to: capped(Self.fit(Self.scaled(want, scale), on: p)))
      (p.contentView as? WKWebView ?? p.contentView?.subviews.first as? WKWebView)?.pageZoom = scale
    }
    // Onboarding is full-screen by definition, so its FRAME must not scale —
    // only what is drawn inside it.
    (onboardingPanel?.contentView as? WKWebView)?.pageZoom = scale
  }

  // The popup that owns the switch sets itself; these are the other two pages,
  // which would otherwise keep their old setting until reopened.
  func soundsChanged(_ on: Bool) {
    let js = "window.__hzSounds && window.__hzSounds(\(on))"
    widgetWeb?.evaluateJavaScript(js)
    chatWeb?.evaluateJavaScript(js)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
