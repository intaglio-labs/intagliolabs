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
  //
  // ...and, since 2026-08-24, `cloudSlot` of empty room ABOVE the bar for the
  // orb's dream cloud (.dream in palette.css). It has to be reserved in the
  // WINDOW, not just in the page: the window is cut to content and anything
  // drawn past its edge is clipped flat, so a bubble that appears above the
  // orb has nowhere to appear unless the room is already there.
  //
  // GROWING THIS DOES NOT MOVE THE BAR. pinnedFrame keeps origin.y (AppKit
  // measures from the bottom) and the page lays out from the top, so extra
  // height is added above the content and the whole widget stays put. That is
  // the only reason a permanent reservation is affordable.
  //
  // WHAT IT COSTS, so nobody has to rediscover it: the widget's window is one
  // rectangle, and the page's own drag handler answers anywhere that is not a
  // control. So this band is 64pt of desktop that grabs the widget instead of
  // the wallpaper, whether or not the cloud is up. That is a bigger version of
  // what the bar row already does (the collapsed pill is 58px of a 312px row),
  // not a new behaviour — but if it ever reads as the widget having an
  // invisible edge, the fix is to grow the window only while the cloud is up,
  // the way fitPopup already resizes the popups.
  private static let cloudSlot: CGFloat = 76
  private static let widgetBase = NSSize(width: 312, height: 114 + cloudSlot)
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
      // .nonactivatingPanel so a click lands on what it hit rather than being
      // spent activating the window first — see WidgetWindow in Windows.swift.
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    w.isFloatingPanel = false
    w.hidesOnDeactivate = false
    // INERT FOR THIS WINDOW, and kept only because it is correct in principle.
    //
    // This was added believing it fixed the two-click switch. It does not, and
    // saying so here is cheaper than someone measuring it again: the flag only
    // withholds key when the CLICKED VIEW reports it does not need key, and
    // WKWebView.needsPanelToBecomeKey is true (measured). Every click into the
    // page therefore takes key regardless of this line. What actually delivers
    // that click is ClickThroughWebView -- see Windows.swift.
    //
    // Left in because it costs nothing and is the right answer for any non-web
    // view this window ever hosts.
    w.becomesKeyOnlyIfNeeded = true
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
    // Capturable. The widget lives BELOW every normal window on purpose — it
    // must never cover the owner's work — but that same depth put it beneath
    // what ⇧⌘4-space will offer, so there was no way to screenshot the app to
    // show somebody. sharingType is what the window server consults for
    // capture; .readWrite is the default but it is set explicitly here because
    // the level makes this window look like desktop furniture and the intent
    // should be written down rather than inferred.
    w.sharingType = .readWrite
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
      if !Self.isUsablyOnScreen(w.frame) { placeBottomRight() }
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

    // DIAGNOSTIC PROBE, off unless HAZLIE_TCC_PROBE=1.
    //
    // Asks for Contacts at launch and writes the answer to a file, so a
    // signing change can be verified without clicking through onboarding.
    //
    // It exists because this took far too long to diagnose, and the comment
    // that used to sit here recorded the WRONG answer: it said entitlements
    // had "been ruled out by testing" and blamed the webview calling context.
    // Entitlements were the whole cause — under the hardened runtime tccd will
    // not display a prompt for a service whose entitlement is missing, and the
    // app carried only audio-input. See widget/Hazlie.entitlements.
    //
    // The testing that "ruled it out" was invalid: the probe was run from a
    // terminal, and a process launched from a shell inherits THAT app's TCC
    // grants, so it reported success no matter what the bundle contained.
    // Launch it with `open -a` and read tccd, never from a shell:
    //   open -a "Intaglio Labs" --env HAZLIE_TCC_PROBE=1
    //   /usr/bin/log stream --predicate 'process == "tccd"'
    // A missing entitlement shows up there as `Policy disallows prompt`.
    if ProcessInfo.processInfo.environment["HAZLIE_TCC_PROBE"] == "1" {
      Permissions.request("contacts") { status in
        let out = FileManager.default.homeDirectoryForCurrentUser
          .appendingPathComponent(".hazlie/logs/tcc-probe.txt")
        try? "launch-time contacts request -> \(status.rawValue)\n"
          .write(to: out, atomically: true, encoding: .utf8)
        NSLog("Intaglio Labs: TCC probe -> \(status.rawValue)")
      }
    }

    // The connectors daemon runs as a child of this app so its file access is
    // attributed to the app rather than to node — see Connectors.swift. Any
    // launchd agent from an older install is retired first, or the two would
    // race for the same cursors.
    DispatchQueue.global(qos: .utility).async {
      Provision.retireConnectorsAgent()
      DispatchQueue.main.async { Connectors.shared.start() }
      // Reading the sources is only half of it. Nothing was turning those rows
      // into anything answerable, so every question abstained on a full
      // database — see Distiller.swift.
      DispatchQueue.main.async { Distiller.shared.start() }
      // And notice the grant arriving later. Granting Full Disk Access makes
      // macOS offer "Quit & Reopen"; this app does not need either half of that
      // offer, but the daemon just started above does need respawning. See
      // FullDiskWatch for why that is the only thing that happens.
      DispatchQueue.main.async { FullDiskWatch.begin() }
    }

    // THE DISPLAY CHANGING IS AN EVENT, and until now nothing treated it as one.
    //
    // The widget's frame is absolute global coordinates. Unplug a monitor, change
    // the arrangement, or switch resolution, and those coordinates keep pointing
    // at wherever they pointed before -- which may be off every screen, or simply
    // nowhere near the corner the widget is supposed to live in. The rescue that
    // handles this existed but ran ONLY at launch, so it fixed the case of
    // "started up on a different display" and never the far more common case of
    // "the display changed while I was using it".
    //
    // Coalesced onto the next main-loop pass: macOS emits this several times
    // during one arrangement change, and re-placing a window per notification is
    // visible as a stutter.
    NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.screenChangeWork?.cancel()
      let work = DispatchWorkItem { [weak self] in self?.rehomeWidget() }
      self.screenChangeWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    // First launch shows the welcome flow. Only completing it sets the flag,
    // so a dismissed flow comes back — and the settings button reopens it on
    // demand regardless.
    if !Bridge.onboarded {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.openOnboarding(resume: true)
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
    // Every panel reports its own disappearance, so the dream band's "is
    // something covering me" answer is maintained in one place rather than at
    // each of the several exits a popup has. Callers that need their own
    // willOrderOut chain onto this rather than replacing it -- see openOnboarding.
    p.willOrderOut = { [weak self] in
      // After this returns the panel is still visible, so the recount has to
      // happen once AppKit has actually taken it down.
      DispatchQueue.main.async { self?.notifyPanelState() }
    }
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.level = .normal
    p.collectionBehavior = [.moveToActiveSpace]
    p.isFloatingPanel = false
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    // Take key only for a control that genuinely needs typing. Without this the
    // popup grabs key on open and the widget behind it needs a click to get it
    // back — see present().
    p.becomesKeyOnlyIfNeeded = true
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
    // The VISIBLE widget, not the window: popupGap is meant to be the gap the
    // owner sees, and measuring from the window's top added the empty cloud band
    // to it.
    let wf = visibleWidgetFrame
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

  // Every popup this app opens along the widget's edge. Onboarding is not in
  // the list: it is a full-screen scrim that deliberately covers everything,
  // and it closes the others itself when it opens.
  private var edgePanels: [PopupPanel?] { [chatPanel, connectionsPanel, peoplePanel, skyPanel] }

  // ONE AT A TIME. Opening any popup closes the others first.
  //
  // They are all placed against the same edge of the widget, so two open at
  // once do not sit side by side -- they overlap, and the one underneath is
  // both unreachable and still listening. It was possible to stack chat,
  // connections, people and the sky view into one pile.
  //
  // Ordering out rather than closing: these panels are kept lazily
  // (isReleasedWhenClosed is false) so they survive hidden and reopen with
  // their state, which is the behaviour the gear toggle depends on.
  // CLICK OUTSIDE TO DISMISS.
  //
  // These are borderless non-activating panels with no chrome, so there is no
  // close button and no window edge to click past — the only ways out were the
  // toggle that opened it and ESC. Every other transient surface on the Mac
  // closes when you look away from it, and one that does not feels stuck.
  //
  // Two monitors, because one cannot see both worlds: the LOCAL one sees clicks
  // delivered to this app (the widget itself, another popup), the GLOBAL one
  // sees clicks that went to any other application. The local monitor must
  // return the event rather than swallow it, or the click that dismisses would
  // also be the click that never reaches the button it landed on.
  private var dismissMonitors: [Any] = []

  private func watchForOutsideClicks() {
    guard dismissMonitors.isEmpty else { return }
    let handle: (NSEvent) -> Void = { [weak self] event in
      guard let self else { return }
      guard let open = self.edgePanels.compactMap({ $0 }).first(where: { $0.isVisible }) else { return }
      // A click INSIDE the popup is the popup being used.
      if event.window === open { return }
      // A click on the widget is a toggle or another opener; those already
      // manage each other, and dismissing here would fight them.
      if event.window === self.widgetWindow { return }
      // Onboarding covers the screen and owns its own dismissal.
      if self.onboardingPanel?.isVisible == true { return }
      // A SCREENSHOT IS NOT AN OUTSIDE CLICK.
      //
      // ⇧⌘4 drags a selection, and that mouse-down reaches this global monitor
      // like any other — so the popup being photographed closed the instant the
      // capture began, and the shot came back empty. Someone could not send a
      // picture of the thing they were asking about.
      //
      // screencaptureui backs the ⇧⌘4 and ⇧⌘5 gestures — the two that involve a
      // mouse — and runs only while a capture is in progress, so its presence
      // answers "is the owner photographing this right now" exactly rather than
      // guessing. (The `screencapture` CLI does NOT go through it, which is worth
      // knowing before testing this from a terminal and concluding it is dead.)
      let capturing = NSWorkspace.shared.runningApplications.contains {
        $0.bundleIdentifier == "com.apple.screencaptureui"
      }
      if capturing { return }
      open.orderOut(nil)
    }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { e in
      handle(e); return e // never swallow: the click still belongs to whatever it hit
    }) { dismissMonitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: handle) {
      dismissMonitors.append(g)
    }
  }

  private func present(_ panel: PopupPanel) {
    watchForOutsideClicks()
    defer { notifyPanelState() } // something now covers the dream band
    for other in edgePanels where other !== panel {
      if other?.isVisible == true { other?.orderOut(nil) }
    }
    place(panel)
    // Frontmost, yes — a popup behind another app's window is not presented.
    NSApp.activate(ignoringOtherApps: true)
    // orderFront, NOT makeKeyAndOrderFront, and this is the two-click fix.
    //
    // makeKeyAndOrderFront handed key to the popup. The widget then was not
    // key, so AppKit spent the next click on it activating rather than
    // clicking, and switching between chat, connections and people cost two
    // presses: one eaten, one that landed. Making the widget a nonactivating
    // panel was not enough on its own — something still had to stop TAKING key
    // from it.
    //
    // orderFront still matters: it stops the popup TAKING key on open, so the
    // widget keeps it and a popup that was opened but not yet touched does not
    // steal typing.
    //
    // The becomesKeyOnlyIfNeeded set in makePanel was credited here with the
    // rest of it, and that part was wrong. The flag defers to the clicked view's
    // needsPanelToBecomeKey, and a webview always answers true, so every click
    // into a popup takes key anyway. Which also means the first click into any
    // popup is a first-mouse click on every open -- delivered now only because
    // the page webviews accept it (ClickThroughWebView, Windows.swift).
    panel.orderFront(nil)
  }

  // Onboarding is not a window in the way the others are: it covers the whole
  // display and dims it, and its content floats on that scrim. So it takes the
  // screen's FULL frame — not visibleFrame, which stops at the menu bar and
  // the Dock and would leave two undimmed strips — and sits above ordinary
  // windows rather than at .normal with the popovers.
  //
  // hasShadow off: makePanel turns it on for popovers, and a shadow around a
  // full-screen rectangle is a dark band down the edge of the display.
  // BridgeDelegate requires the no-argument form, and Swift will not accept a
  // defaulted parameter as the witness for it. So this is the protocol's
  // entry point — the gear replaying the flow — and it never resumes.
  func openOnboarding() { openOnboarding(resume: false) }

  func openOnboarding(resume: Bool) {
    // Opening the flow IS pretending this is a fresh install — the owner's
    // rule: replay behaves like the first time, every time. So the flag
    // drops, and only FINISHING sets it back; escape mid-replay and the flow
    // returns at next launch, exactly as a dismissed first run does. On the
    // real first launch this is already false and the line is a no-op.
    Bridge.onboarded = false
    // Replay is a fresh install, so the hand-holds rewind with it: every
    // connector walks the user through again on its next first press.
    Bridge.handheld = []
    // The flow covers the display, so nothing may be left open underneath it —
    // a popup under the scrim is unreachable and still live.
    for other in edgePanels where other?.isVisible == true { other?.orderOut(nil) }
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
      let reportPanels = p.willOrderOut // set in makePanel; chained, not replaced
      p.willOrderOut = { [weak self] in
        reportPanels?()
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
    // RESUME OR REWIND, and they are different intentions.
    //
    // Reopening from settings is a replay and starts at the welcome. A launch
    // mid-flow is a CONTINUATION — macOS offers "Quit & Reopen" the moment Full
    // Disk Access is granted, and taking it used to throw away every step
    // already done and start again from the welcome, immediately after the
    // hardest step in the flow. Guarded because on the very first open the page
    // has not loaded yet, which is harmless: a fresh page starts on screen 1.
    let web = p.contentView as? WKWebView
    if resume, let step = Bridge.onboardingStep,
       let json = String(data: (try? JSONSerialization.data(withJSONObject: [step])) ?? Data(),
                         encoding: .utf8) {
      web?.evaluateJavaScript(
        "window.__hzOnboardingResume && window.__hzOnboardingResume(\(json)[0])")
    } else {
      web?.evaluateJavaScript("window.__hzOnboardingReset && window.__hzOnboardingReset()")
    }
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
    // The ring points at the BAR: the reserved band is empty almost all of the
    // time, and ringing it would circle a rectangle whose top half is nothing.
    // That is exactly visibleWidgetFrame, which now owns the arithmetic this
    // used to do inline -- and owns it for every other caller too.
    let w = visibleWidgetFrame
    let p = panel.frame
    guard p.width > 0, p.height > 0 else { return [:] }
    return [
      "x": Double((w.minX - p.minX) / p.width),
      // Flipped: AppKit measures up from the bottom, CSS down from the top.
      "y": Double((p.maxY - w.maxY) / p.height),
      "w": Double(w.width / p.width),
      "h": Double(w.height / p.height),
      // THE TOP OF THE WHOLE WINDOW, not of the ring above.
      //
      // `y` is deliberately the top of the BAR: the slot subtracted above is
      // empty most of the time and ringing it would circle a rectangle whose
      // top half is nothing. But the WINDOW still owns that band, and for the
      // length of this scene the window sits one level ABOVE the onboarding
      // panel (see spotlightWidget) -- so the empty band takes clicks that
      // never reach the page under it.
      //
      // The card was placed 26pt above `y` and the slot is 76pt, which put the
      // "lets go" button roughly 50pt INSIDE that window. It rendered, it
      // highlighted, and clicking it did nothing, because the click was landing
      // on the widget. This is the line the card has to clear instead, and it
      // only became a distinct line when the cloud slot was added (main.swift's
      // header, 2026-08-24) -- before that the two tops were the same and 26pt
      // was clear air.
      "clearY": Double((p.maxY - widgetWindow.frame.maxY) / p.height),
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
        // The WHOLE window on purpose: this asks whether the thing fits on the
        // screen, and the empty band is part of what has to fit.
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
  // Download progress, straight into whichever setup surface is open. The
  // onboarding panel owns the flow; the connections popup shows the same
  // controls afterwards, so both get it and whichever is not there ignores it.
  // GET OUT OF THE PROMPT'S WAY.
  //
  // The onboarding scrim is full-screen at .floating (level 3). A TCC prompt is
  // an ORDINARY window at level 0, so it opened behind the scrim — invisible,
  // unanswerable, and eventually recorded as a refusal. That is why every
  // "allow" turned into "denied" without anything appearing: the prompt was
  // there the whole time, underneath.
  //
  // This paragraph used to say that was PROVEN — that a minimal signed app with
  // no windows went straight to authorized, leaving the scrim as the only
  // difference. That test was run from a terminal, and a process launched from
  // a shell inherits the terminal's TCC grants, so it proved nothing. The
  // prompts were actually blocked by a missing hardened-runtime entitlement
  // (widget/Hazlie.entitlements). Lowering the scrim is still right — a
  // full-screen window at .floating really does cover a level-0 dialog — but it
  // was not the cause, and the fix for the cause is not here.
  //
  // So the scrim drops to .normal for the length of the ask and goes back after.
  // Lowering rather than hiding: the flow keeps its place, and a scrim that
  // vanished and reappeared would read as a flicker.
  func yieldForPrompt(_ yield: Bool) {
    guard let p = onboardingPanel, p.isVisible else { return }
    p.level = yield ? .normal : .floating
  }

  // GET OUT OF SETTINGS' WAY, and stay out.
  //
  // Full Disk Access is granted in System Settings, which is an ordinary
  // level-0 window — so the full-screen scrim buried it, and the owner was
  // told to go somewhere they could not reach. Lowering alone is not enough
  // here: two windows at .normal still order against each other, and the
  // scrim was in front. It goes to the BACK for the length of the visit and
  // comes forward again when the helper card closes.
  func yieldForSettings(_ yield: Bool) {
    guard let p = onboardingPanel, p.isVisible else { return }
    if yield {
      // BELOW normal, not at it. Lowering to .normal was not enough: dragging
      // the app out of the helper card activates this app, and AppKit brings
      // its windows forward — so the scrim landed back on top of Settings
      // mid-drag, over the list the app was being dropped onto. A level under
      // .normal cannot win that race no matter who activates.
      p.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
      p.orderBack(nil)
    } else {
      p.level = .floating
      p.orderFrontRegardless()
    }
  }

  func setupProgress(_ payload: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(payload),
          let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    let js = "window.__hzSetup && window.__hzSetup(\(json))"
    eval(onboardingPanel?.contentView as? WKWebView, js)
    eval(connectionsPanel?.contentView as? WKWebView, js)
  }

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
    // Visible frame again, for the same reason: measured from the window's top
    // this understated the available height by the whole cloud band, and popups
    // were capped shorter than the screen actually allowed.
    let room = v.maxY - Self.screenMargin - (visibleWidgetFrame.maxY + Self.popupGap)
    // If the widget has been dragged high enough that there is no usable room
    // above it, overlap is unavoidable and a popup squeezed to 200pt would be
    // useless anyway. Fall back to the screen and let `place` sort it out.
    return room >= 240 ? room : .greatestFiniteMagnitude
  }
  private static let popupGap: CGFloat = 12

  // The widget's frame at a given scale: right edge against the screen's right
  // edge, bottom edge wherever it already was, clamped so a tall widget near
  // the bottom cannot end up under the Dock.
  // THE WIDGET YOU CAN SEE, which is not the window it lives in.
  //
  // The window reserves `cloudSlot` of empty room above the bar for the orb's
  // dream cloud. That band is transparent and, most of the time, empty -- but it
  // is still part of the window, so `widgetWindow.frame.maxY` is up to 76pt
  // above anything the owner can actually see.
  //
  // Every position derived from the widget wants THIS rectangle, and until this
  // existed each call site was on its own: one subtracted the slot, the rest did
  // not, and the ones that did not produced an 88pt gap where 12 was intended, a
  // popup capped 76pt short of the room it had, and an onboarding button placed
  // inside a transparent window that swallowed its clicks. Those were one bug
  // wearing three faces, which is what an invariant nobody owns looks like.
  //
  // The two callers that legitimately want the WHOLE window -- "does it fit on
  // this screen" and the onboarding card's clearance line -- say so by reading
  // widgetWindow.frame directly, and are commented where they do.
  // TELL THE WIDGET PAGE WHETHER ANYTHING IS COVERING ITS DREAM BAND.
  //
  // The band above the bar is empty almost always, which is why popups are
  // placed against the visible widget and not the window (see
  // visibleWidgetFrame). "Almost" is the catch: tapping the orb raises a 76pt
  // dream bubble INTO that band for 2.4s, and a popup sitting 12pt above the bar
  // covers nearly all of it. The bubble would play, unseen, behind the panel.
  //
  // Rather than move an open panel 76pt up and back inside 2.4 seconds -- which
  // reads worse than the thing it fixes -- the page simply does not raise the
  // bubble while a panel is open. The orb still answers the finger: the wake
  // animation and its tone run either way, which is the part that matters.
  //
  // WHEN VOICE ACTUALLY SHIPS this has to change. The bubble stops being a
  // "coming soon" placeholder and starts carrying the answer, and an answer that
  // is silently withheld because a panel is open is a bug rather than a tidy-up.
  // At that point the popup has to yield the band instead.
  private func notifyPanelState() {
    let covered = edgePanels.contains { $0?.isVisible == true }
    eval(widgetWeb, "window.__hzPanels && window.__hzPanels(\(covered))")
  }

  private var visibleWidgetFrame: NSRect {
    var f = widgetWindow.frame
    let slot = Self.cloudSlot * CGFloat(Bridge.scale)
    if f.height > slot { f.size.height -= slot } // AppKit's origin is bottom-left: this lowers maxY
    return f
  }

  // Enough of the widget to be seen and grabbed. This used to be 80x40, which a
  // widget hanging 90% off the side of a screen satisfies -- so the rescue below
  // looked at something nobody could use and decided it was fine. The bar is now
  // most of the widget, because "reachable" was never the interesting question:
  // "is this where someone would expect to find it" is.
  /// Coalesces a burst of screen-parameter notifications into one re-place.
  private var screenChangeWork: DispatchWorkItem?

  /// Put the widget back where it belongs after the screens changed.
  ///
  /// Two different situations, and they want different answers. A widget that is
  /// still usably on a screen has only drifted relative to the corner, so it is
  /// re-anchored against the screen it is on and keeps the height the owner
  /// chose. A widget that is no longer usably anywhere has effectively been lost,
  /// and goes home to the bottom-right of the main screen rather than being
  /// nudged toward a position nobody can reach.
  private func rehomeWidget() {
    let old = widgetWindow.frame
    let target: NSRect
    if Self.isUsablyOnScreen(old), let v = (widgetWindow.screen ?? NSScreen.main)?.visibleFrame {
      target = Self.reanchored(old, from: widgetWindow.screen?.visibleFrame ?? v, to: v)
    } else if let v = NSScreen.main?.visibleFrame {
      var f = old
      f.origin = NSPoint(x: v.maxX - f.width - Self.edgeInset, y: v.minY + 24)
      target = f
    } else {
      return
    }
    guard target != old else { return }
    widgetWindow.setFrame(target, display: true)
    // The popups are placed against the widget, so anything open has to follow it
    // rather than stay pinned to where the widget used to be. edgePanels is
    // exactly that set; the onboarding panel is deliberately absent, being a
    // full-screen scrim sized to the screen rather than placed against the
    // widget -- running it through placedFrame would shrink it to a popup.
    for panel in edgePanels {
      guard let panel, panel.isVisible else { continue }
      panel.setFrame(placedFrame(panel.frame.size), display: true)
    }
    // The scrim is sized to the SCREEN, so it needs the opposite treatment: not
    // re-placed against the widget, but re-stretched. A screen change mid-flow
    // otherwise leaves a dim covering part of the display and bare desktop beside
    // it, with the flow's own layout measured against the old rectangle.
    if let panel = onboardingPanel, panel.isVisible,
       let frame = (widgetWindow.screen ?? NSScreen.main)?.frame {
      panel.setFrame(frame, display: true)
      // The last scene positions its ring and card from measurements of this
      // window, so it has to take them again against the new one.
      eval(panel.contentView as? WKWebView, "window.__hzRehome && window.__hzRehome()")
    }
  }

  private static func isUsablyOnScreen(_ f: NSRect) -> Bool {
    NSScreen.screens.contains { screen in
      let hit = screen.visibleFrame.intersection(f)
      return hit.width >= f.width * 0.75 && hit.height >= f.height * 0.75
    }
  }

  private static func pinnedFrame(_ window: NSWindow, _ scale: Double) -> NSRect {
    let size = fit(scaled(widgetBase, scale), on: window)
    var frame = NSRect(origin: window.frame.origin, size: size)
    guard let v = (window.screen ?? NSScreen.main)?.visibleFrame else { return frame }
    frame.origin.x = v.maxX - size.width - edgeInset
    frame.origin.y = max(v.minY + 24, min(frame.origin.y, v.maxY - size.height))
    return frame
  }

  // Re-place the widget for a screen that is not the one it was placed on.
  //
  // x is pinned to the right edge as always. y is the part with a choice in it,
  // and the rule is: KEEP THE DISTANCE FROM WHICHEVER EDGE IT SAT CLOSER TO.
  //
  // The alternative -- keeping y as a fraction of screen height -- sounds more
  // faithful and behaves worse. The widget's home is the bottom corner, the Dock
  // is down there with it, and a proportional y drifts it off that line as soon
  // as the aspect ratio changes: a widget resting just above the Dock on a 16:10
  // display lands somewhere in open space on a 4:3 one. Anchoring to the nearer
  // edge keeps the common case (near the bottom) exactly where it belongs, and
  // still honours a deliberate drag upward by keeping it near the top.
  private static func reanchored(_ frame: NSRect, from old: NSRect, to v: NSRect) -> NSRect {
    var f = frame
    f.origin.x = v.maxX - f.width - edgeInset
    let fromBottom = frame.minY - old.minY
    let fromTop = old.maxY - frame.maxY
    f.origin.y = fromBottom <= fromTop ? v.minY + fromBottom : v.maxY - f.height - fromTop
    // Whatever the anchor said, it has to land on the screen it was given.
    f.origin.y = max(v.minY + 24, min(f.origin.y, v.maxY - f.height))
    return f
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

extension AppDelegate {
  // The child dies with us rather than outliving the app that is responsible
  // for it, holding a database handle and a set of cursors open.
  func applicationWillTerminate(_ notification: Notification) {
    Connectors.shared.stop()
    Distiller.shared.stop()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
