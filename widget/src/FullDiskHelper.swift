import AppKit
import CoreGraphics

// THE FULL DISK ACCESS HELPER — a floating card you drag the app out of.
//
// Full Disk Access is the one permission macOS refuses to prompt for. There is no
// API, no dialog, and no way to ask: the owner has to open System Settings, find
// this app in a list, and flip a switch. Every other permission in this flow is one
// press, and this one used to be "we opened Settings somewhere behind you, good
// luck" — which ended with the step being skipped, which is why Messages and Notes
// read nothing.
//
// So this does what Settings will not: it puts the app's icon on screen, above
// Settings, and lets it be DRAGGED into the list. Dropping an app on the Full Disk
// Access table adds it already switched on, which is fewer steps than finding a row
// that is already there.
//
// It watches for the grant rather than asking the owner to come back and confirm —
// `Permissions.fullDisk()` is a real protected read, so the moment the switch goes
// on, the card says so and closes itself.
final class FullDiskHelper {
  static let shared = FullDiskHelper()
  private init() {}

  private var panel: NSPanel?
  private var timer: Timer?
  private var onFinish: (() -> Void)?
  private var statusLabel: NSTextField?
  private var titleLabel: NSTextField?
  private var statusDot: PulseDot?

  var isVisible: Bool { panel?.isVisible == true }

  /// Show the card and start watching. `onFinish` fires once, on grant or dismissal,
  /// and is what puts the onboarding scrim back.
  func begin(onFinish: @escaping () -> Void) {
    // Already up: re-raise rather than stacking a second card.
    if let p = panel, p.isVisible {
      p.orderFrontRegardless()
      return
    }
    self.onFinish = onFinish
    let p = buildPanel()
    panel = p
    place(p)
    p.orderFrontRegardless()
    // Settings takes a moment to open, and until it does there is nothing to sit
    // beside. Re-place once it is up, so the card lands next to the list rather
    // than wherever the fallback put it.
    for delay in [0.8, 1.8, 3.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak p] in
        guard let self, let p, p.isVisible else { return }
        self.place(p)
      }
    }
    startWatching()
  }

  func end() {
    timer?.invalidate()
    timer = nil
    panel?.orderOut(nil)
    panel = nil
    statusLabel = nil
    titleLabel = nil
    let f = onFinish
    onFinish = nil
    f?()
  }

  // MARK: watching

  private func startWatching() {
    timer?.invalidate()
    let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self else { return }
      guard Permissions.fullDisk() == .granted else { return }
      self.timer?.invalidate()
      self.timer = nil
      self.showGranted()
    }
    // .common, not the default mode: a drag or a menu puts the run loop into
    // event tracking, and a default-mode timer stops firing for exactly as long as
    // the owner is doing the thing this is watching for.
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func showGranted() {
    // The daemon started before the switch moved and is holding a denial it will
    // not re-examine. Respawn it HERE rather than waiting for the app to be
    // reactivated: the owner is looking at this card, and the point of the card
    // is that the work is already done by the time it goes green.
    FullDiskWatch.check()
    titleLabel?.stringValue = "that's it \u{2014} thank you"
    statusLabel?.stringValue = "Messages and Notes are readable"
    statusLabel?.textColor = Palette.ok
    statusDot?.settle(to: Palette.ok)
    // Let it be read before it disappears. A card that vanishes the instant the
    // switch moves leaves the owner unsure whether it worked.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.end() }
  }

  // MARK: the card

  private func buildPanel() -> NSPanel {
    let size = NSSize(width: 320, height: 392)
    let p = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      // Non-activating: dragging out of this card must not pull focus away from
      // System Settings, which is the window the drop has to land on.
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    // Above System Settings (an ordinary level-0 window). The onboarding scrim
    // goes BELOW .normal for the duration — see yieldForSettings.
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.isMovableByWindowBackground = true
    p.appearance = NSAppearance(named: .darkAqua)

    let root = RoundedView(frame: NSRect(origin: .zero, size: size))
    root.autoresizingMask = [.width, .height]
    p.contentView = root

    // Eyebrow: names the pane this belongs to, so the card is anchored to what is
    // on screen next to it rather than floating free.
    let hint = label("FULL DISK ACCESS", size: 10, weight: .semibold, color: Palette.hazelnut)
    hint.frame = NSRect(x: 20, y: size.height - 40, width: size.width - 40, height: 16)
    hint.alignment = .center

    let icon = AppDragView(frame: NSRect(x: (size.width - 132) / 2, y: 196, width: 132, height: 132))
    icon.onDragStart = { [weak self] in self?.setTitle("drop it on the list") }
    icon.onDragEnd = { [weak self] in self?.setTitle("drag me onto the list") }

    let title = label("drag me onto the list", size: 15, weight: .semibold, color: Palette.fg)
    title.frame = NSRect(x: 20, y: 162, width: size.width - 40, height: 22)
    title.alignment = .center
    titleLabel = title

    // The second route, spelled out. The row is ALREADY in the list by the time
    // this card appears — touching a protected path is what put it there — so
    // "switch it on" is often the shorter path, and hiding it behind a disclosure
    // triangle was how the old flow buried the only instruction that mattered.
    let orRule = SeparatorView(frame: NSRect(x: 40, y: 140, width: size.width - 80, height: 14))

    let sub = label("or find \u{201C}intaglio labs\u{201D} in the list\nand switch it on",
                    size: 12, weight: .regular, color: Palette.secondary)
    sub.frame = NSRect(x: 22, y: 96, width: size.width - 44, height: 36)
    sub.alignment = .center
    sub.maximumNumberOfLines = 2

    // The live bit. Without it the card is a poster; with it, the card is watching
    // alongside the owner and says so the instant the switch moves.
    let statusRow = NSView(frame: NSRect(x: 20, y: 34, width: size.width - 40, height: 26))
    let dot = PulseDot(frame: NSRect(x: (size.width - 40) / 2 - 66, y: 8, width: 9, height: 9))
    statusDot = dot
    let status = label("waiting for the switch", size: 11, weight: .medium, color: Palette.muted)
    status.frame = NSRect(x: (size.width - 40) / 2 - 52, y: 4, width: 190, height: 16)
    status.alignment = .left
    statusLabel = status
    statusRow.addSubview(dot)
    statusRow.addSubview(status)

    let close = NSButton(frame: NSRect(x: size.width - 34, y: size.height - 32, width: 22, height: 22))
    close.title = "\u{2715}"
    close.isBordered = false
    close.font = .systemFont(ofSize: 13, weight: .medium)
    close.contentTintColor = Palette.muted
    close.target = self
    close.action = #selector(closePressed)

    root.addSubview(hint)
    root.addSubview(icon)
    root.addSubview(title)
    root.addSubview(orRule)
    root.addSubview(sub)
    root.addSubview(statusRow)
    root.addSubview(close)
    return p
  }

  private func setTitle(_ t: String) { titleLabel?.stringValue = t }

  @objc private func closePressed() { end() }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight,
                     color: NSColor) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = .systemFont(ofSize: size, weight: weight)
    f.textColor = color
    f.backgroundColor = .clear
    f.isBezeled = false
    f.isEditable = false
    return f
  }

  /// Beside the Settings window, not at the edge of the display.
  ///
  /// On a wide screen "right-hand side" put the card a metre of pixels away from
  /// the list it is meant to be dragged into. So this finds the Settings window and
  /// sits next to it — right if there is room, left otherwise — and falls back to
  /// the screen edge only while Settings is still opening.
  private func place(_ p: NSPanel) {
    guard let screen = NSScreen.main else { return }
    let v = screen.visibleFrame
    let f = p.frame
    let gap: CGFloat = 24

    if let s = settingsFrame(on: screen) {
      let x = (s.maxX + gap + f.width <= v.maxX) ? s.maxX + gap : s.minX - gap - f.width
      p.setFrameOrigin(NSPoint(x: min(max(x, v.minX + 8), v.maxX - f.width - 8),
                               y: s.midY - f.height / 2))
      return
    }
    p.setFrameOrigin(NSPoint(x: v.maxX - f.width - 40, y: v.midY - f.height / 2))
  }

  /// System Settings' window in Cocoa coordinates. CGWindowList reports a
  /// top-left origin and AppKit wants bottom-left, so the y is flipped against the
  /// full screen height rather than the visible frame.
  private func settingsFrame(on screen: NSScreen) -> NSRect? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
      as? [[String: Any]] ?? []
    for w in list {
      guard (w[kCGWindowOwnerName as String] as? String) == "System Settings",
            (w[kCGWindowLayer as String] as? Int) == 0,
            let b = w[kCGWindowBounds as String] as? [String: CGFloat],
            let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
            width > 200, height > 200 else { continue }
      return NSRect(x: x, y: screen.frame.height - y - height, width: width, height: height)
    }
    return nil
  }
}

// The same values palette.css uses, so this AppKit card and the webview surfaces
// are one design rather than two that merely look similar. Kept literal because
// a Swift window cannot read a stylesheet.
enum Palette {
  static let bg        = NSColor(srgbRed: 0.078, green: 0.078, blue: 0.071, alpha: 0.98)
  static let fg        = NSColor(srgbRed: 0.918, green: 0.918, blue: 0.918, alpha: 1)   // #eaeaea
  static let secondary = NSColor(srgbRed: 0.541, green: 0.541, blue: 0.541, alpha: 1)   // #8a8a8a
  static let muted     = NSColor(srgbRed: 0.443, green: 0.443, blue: 0.443, alpha: 1)
  static let hazelnut  = NSColor(srgbRed: 0.773, green: 0.647, blue: 0.427, alpha: 1)   // #c5a56d
  static let ok        = NSColor(srgbRed: 0.200, green: 1.000, blue: 0.400, alpha: 1)   // #33ff66
  static let hairline  = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08)
}

// A hairline with "or" set into it. Two routes to the same grant, and the rule is
// what says they are alternatives rather than steps 1 and 2.
private final class SeparatorView: NSView {
  override func draw(_ dirtyRect: NSRect) {
    let mid = bounds.midY
    let text = "or" as NSString
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 10, weight: .medium),
      .foregroundColor: Palette.muted,
    ]
    let w = text.size(withAttributes: attrs).width
    let gap = w + 16
    Palette.hairline.setStroke()
    let l = NSBezierPath()
    l.move(to: NSPoint(x: 0, y: mid))
    l.line(to: NSPoint(x: (bounds.width - gap) / 2, y: mid))
    l.move(to: NSPoint(x: (bounds.width + gap) / 2, y: mid))
    l.line(to: NSPoint(x: bounds.width, y: mid))
    l.lineWidth = 1
    l.stroke()
    text.draw(at: NSPoint(x: (bounds.width - w) / 2, y: mid - 7), withAttributes: attrs)
  }
}

// A dot that breathes while the card is waiting and stops when the grant lands.
// Motion is the cheapest way to say "still watching" without a spinner, which
// would read as work in progress rather than attention.
final class PulseDot: NSView {
  private var color = Palette.hazelnut
  private var pulsing = true

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    guard window != nil, pulsing else { return }
    wantsLayer = true
    layer?.cornerRadius = bounds.width / 2
    layer?.backgroundColor = color.cgColor
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 1.0
    a.toValue = 0.25
    a.duration = 0.9
    a.autoreverses = true
    a.repeatCount = .infinity
    // Respect the system setting rather than inventing one: a card that throbs
    // at someone who asked for less motion is not charming.
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      layer?.add(a, forKey: "pulse")
    }
  }

  func settle(to c: NSColor) {
    pulsing = false
    color = c
    wantsLayer = true
    layer?.removeAnimation(forKey: "pulse")
    layer?.opacity = 1
    layer?.backgroundColor = c.cgColor
  }
}

// The card's ground: rounded, dark, hairline edge. Drawn rather than a CSS surface
// because this window is AppKit — it has to sit above System Settings, and a
// WKWebView here would buy a stylesheet and cost a whole second process.
private final class RoundedView: NSView {
  override var isFlipped: Bool { false }
  override func draw(_ dirtyRect: NSRect) {
    let r = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                         xRadius: 18, yRadius: 18)
    Palette.bg.setFill()
    r.fill()
    Palette.hairline.setStroke()
    r.lineWidth = 1
    r.stroke()
  }
}

// THE DRAGGABLE APP.
//
// The pasteboard carries the app bundle's file URL, which is what the Full Disk
// Access table accepts as a drop. The icon is the real Finder icon rather than a
// drawing of it, so what is being dragged looks exactly like the row it becomes.
private final class AppDragView: NSView, NSDraggingSource {
  var onDragStart: (() -> Void)?
  var onDragEnd: (() -> Void)?
  private let icon: NSImage = AppDragView.sharpIcon()

  // NSWorkspace.icon(forFile:) hands back an image sized 32x32. Drawn into a
  // 128pt well it is UPSCALED — the icon looked like a thumbnail of itself, which
  // is a poor advertisement for the app you are being asked to trust with your
  // whole disk. The .icns carries every size up to 1024, so read it directly and
  // declare a size big enough that AppKit picks a large representation.
  static func sharpIcon() -> NSImage {
    if let raw = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String {
      let base = raw.hasSuffix(".icns") ? String(raw.dropLast(5)) : raw
      if let url = Bundle.main.url(forResource: base, withExtension: "icns"),
         let img = NSImage(contentsOf: url) {
        img.size = NSSize(width: 256, height: 256)
        return img
      }
    }
    let img = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    img.size = NSSize(width: 256, height: 256)
    return img
  }

  // THE ICON IS NOT THE WINDOW'S HANDLE.
  //
  // The card sets isMovableByWindowBackground so it can be nudged aside, and
  // NSView answers YES to mouseDownCanMoveWindow by default — so AppKit took the
  // mouse-down at the window level and slid the whole card across the screen
  // instead of starting a drag. The icon has to refuse, or the one gesture this
  // view exists for is the one gesture it never sees.
  override var mouseDownCanMoveWindow: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    NSGraphicsContext.current?.imageInterpolation = .high
    icon.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
  }

  override func mouseDown(with event: NSEvent) {
    let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
    item.setDraggingFrame(bounds, contents: icon)
    onDragStart?()
    beginDraggingSession(with: [item], event: event, source: self)
  }

  func draggingSession(_ session: NSDraggingSession,
                       sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    // .copy: the app is not being moved anywhere, only pointed at.
    .copy
  }

  // An abandoned drag has to put the words back. Left saying "drop it on the
  // list" after nothing was dropped, the card is instructing you to finish a
  // gesture you already gave up on.
  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint,
                       operation: NSDragOperation) {
    onDragEnd?()
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }
}
