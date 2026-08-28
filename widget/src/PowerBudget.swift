import Foundation
import IOKit.ps

// WHETHER THE MACHINE CAN AFFORD BACKGROUND WORK RIGHT NOW.
//
// The distiller is a local model pass over every conversation in the corpus. A
// mature corpus can require hours of repeated passes. Run flat out it is indistinguishable
// from a stress test: the owner's laptop gets hot, kernel_task starts stealing
// cycles to cool it, and everything else on the machine slows down to pay for
// catching up on a backlog that nobody is waiting on.
//
// Nothing here throttles work the owner ASKED for. A question typed into the
// panel is answered at whatever speed the machine can manage, always. This
// governs only the passes that run on their own.
enum PowerBudget {
  /// Plugged in and cool: drain the backlog at the busy cadence.
  case full
  /// On battery, or warm: keep up with what just arrived and let the backlog
  /// wait for a charger. The app stays current; the battery is not spent on
  /// history that has been sitting there for years.
  case trickle
  /// Low Power Mode, or thermals the OS calls serious. Stop until it clears --
  /// Low Power Mode is the owner saying so in the one place macOS provides.
  case paused

  static var current: PowerBudget {
    let info = ProcessInfo.processInfo
    // The owner asked for less. Nothing background runs.
    if info.isLowPowerModeEnabled { return .paused }
    switch info.thermalState {
    case .critical, .serious:
      // .serious is already "fans at maximum, and the OS is throttling". Adding
      // an inference loop to that is how a warm machine becomes an unusable one.
      return .paused
    case .fair:
      return onACPower ? .trickle : .paused
    default:
      return onACPower ? .full : .trickle
    }
  }

  /// True on AC, and true on any machine with no battery to speak of -- a Mac
  /// that cannot be unplugged should never be told to conserve.
  static var onACPower: Bool {
    guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let kind = IOPSGetProvidingPowerSourceType(snapshot)?.takeRetainedValue()
    else { return true }
    return (kind as String) == kIOPMACPowerKey
  }

  /// Posted when the answer above may have changed, so a supervisor can
  /// re-decide instead of waiting out an interval it chose under old conditions.
  /// Plugging in should start the backlog draining, not be noticed a quarter of
  /// an hour later.
  static let didChange = Notification.Name("io.intaglio.powerBudgetDidChange")

  private static var watching = false

  /// Begin forwarding thermal, low-power and power-source changes to `didChange`.
  /// Idempotent; call from the main thread at launch.
  static func startWatching() {
    guard !watching else { return }
    watching = true
    let center = NotificationCenter.default
    let relay: (Notification) -> Void = { _ in
      NotificationCenter.default.post(name: PowerBudget.didChange, object: nil)
    }
    center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification,
                       object: nil, queue: .main, using: relay)
    center.addObserver(forName: NSNotification.Name.NSProcessInfoPowerStateDidChange,
                       object: nil, queue: .main, using: relay)

    // The power SOURCE has no NotificationCenter equivalent -- it is a run loop
    // source from IOKit. The callback is a C function pointer and so cannot
    // capture anything, which is why it does nothing but post the notification
    // everything else already listens for.
    if let source = IOPSNotificationCreateRunLoopSource({ _ in
      DispatchQueue.main.async {
        NotificationCenter.default.post(name: PowerBudget.didChange, object: nil)
      }
    }, nil)?.takeRetainedValue() {
      CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }
  }
}
