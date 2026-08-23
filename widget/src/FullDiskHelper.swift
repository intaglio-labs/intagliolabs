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
    titleLabel?.stringValue = "that's it — thank you"
    statusLabel?.stringValue = "Messages and Notes are readable now"
    statusLabel?.textColor = NSColor(srgbRed: 0.20, green: 1.0, blue: 0.40, alpha: 1)
    // Let it be read before it disappears. A card that vanishes the instant the
    // switch moves leaves the owner unsure whether it worked.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.end() }
  }

  // MARK: the card

  private func buildPanel() -> NSPanel {
    let size = NSSize(width: 300, height: 330)
    let p = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      // Non-activating: dragging out of this card must not pull focus away from
      // System Settings, which is the window the drop has to land on.
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    // Above System Settings (an ordinary level-0 window) and above the onboarding
    // scrim, which drops to .normal for the duration — see yieldForSettings.
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.isMovableByWindowBackground = true
    p.appearance = NSAppearance(named: .darkAqua)

    let root = RoundedView(frame: NSRect(origin: .zero, size: size))
    root.autoresizingMask = [.width, .height]
    p.contentView = root

    let title = label("drag me into the list", size: 15, weight: .semibold,
                      color: NSColor(srgbRed: 0.92, green: 0.92, blue: 0.92, alpha: 1))
    title.frame = NSRect(x: 20, y: 68, width: size.width - 40, height: 22)
    title.alignment = .center
    titleLabel = title

    let sub = label("…or find “intaglio labs” in the list and switch it on.",
                    size: 12, weight: .regular,
                    color: NSColor(srgbRed: 0.54, green: 0.54, blue: 0.54, alpha: 1))
    sub.frame = NSRect(x: 22, y: 26, width: size.width - 44, height: 38)
    sub.alignment = .center
    sub.maximumNumberOfLines = 2
    sub.lineBreakMode = .byWordWrapping
    statusLabel = sub

    let icon = AppDragView(frame: NSRect(x: (size.width - 128) / 2, y: 108, width: 128, height: 128))
    icon.onDragStart = { [weak self] in
      self?.titleLabel?.stringValue = "drop it on the list"
    }

    let hint = label("Full Disk Access", size: 11, weight: .medium,
                     color: NSColor(srgbRed: 0.77, green: 0.65, blue: 0.43, alpha: 1))
    hint.frame = NSRect(x: 20, y: 258, width: size.width - 40, height: 18)
    hint.alignment = .center

    let close = NSButton(frame: NSRect(x: size.width - 34, y: size.height - 32, width: 22, height: 22))
    close.title = "✕"
    close.isBordered = false
    close.font = .systemFont(ofSize: 13, weight: .medium)
    close.contentTintColor = NSColor(srgbRed: 0.54, green: 0.54, blue: 0.54, alpha: 1)
    close.target = self
    close.action = #selector(closePressed)

    root.addSubview(hint)
    root.addSubview(icon)
    root.addSubview(title)
    root.addSubview(sub)
    root.addSubview(close)
    return p
  }

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

// The card's ground: rounded, dark, hairline edge. Drawn rather than a CSS surface
// because this window is AppKit — it has to sit above System Settings, and a
// WKWebView here would buy a stylesheet and cost a whole second process.
private final class RoundedView: NSView {
  override var isFlipped: Bool { false }
  override func draw(_ dirtyRect: NSRect) {
    let r = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                         xRadius: 18, yRadius: 18)
    NSColor(srgbRed: 0.078, green: 0.078, blue: 0.071, alpha: 0.98).setFill()
    r.fill()
    NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08).setStroke()
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
  private let icon: NSImage = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)

  // THE ICON IS NOT THE WINDOW'S HANDLE.
  //
  // The card sets isMovableByWindowBackground so it can be nudged aside, and
  // NSView answers YES to mouseDownCanMoveWindow by default — so AppKit took the
  // mouse-down at the window level and slid the whole card across the screen
  // instead of starting a drag. The icon has to refuse, or the one gesture this
  // view exists for is the one gesture it never sees.
  override var mouseDownCanMoveWindow: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
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

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }
}
