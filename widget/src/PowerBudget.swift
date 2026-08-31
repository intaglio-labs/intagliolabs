import Foundation
import IOKit.pwr_mgt

// THE OWNER CHOOSES THE PERFORMANCE POLICY.
//
// The previous policy inferred intent from the charger, Low Power Mode and the
// thermal state. That made a long import silently stop when the Mac was
// unplugged or warm, then resume after a power-source change. Both modes below
// now run under every one of those conditions. The choice only controls HOW
// aggressively local background work runs:
//
//   god mode      the machine-specific concurrency ceiling, large passes,
//                 user-initiated process priority
//   battery saver small passes and utility priority
// NAMED FOR WHAT THEY DO, not for a mood.
//
// "God Mode" told the owner nothing about the machine and "Battery Saver"
// implied it was about the charger, which it is not -- neither setting reads the
// power source. The difference is concrete and worth stating plainly: how much
// work goes into one pass, and what priority macOS gives it.
//
// The stored strings change with the labels, so `migrate()` below maps the old
// values forward. Leaving "god_mode" in the preference file to avoid a migration
// would keep the name in the one place a person might actually go looking.
enum PerformanceMode: String, CaseIterable {
  /// Larger passes, foreground priority. Imports and indexing finish sooner.
  case fullSpeed = "full_speed"
  /// Smaller passes, background priority. Slower, and the machine stays quiet.
  case lessPower = "less_power"

  /// What this mode was called before the rename, for reading old preferences.
  static func migrate(_ raw: String) -> PerformanceMode? {
    switch raw {
    case "god_mode": return .fullSpeed
    case "battery_saver": return .lessPower
    default: return PerformanceMode(rawValue: raw)
    }
  }
}

enum PowerBudget {
  case full
  case trickle

  static let defaultsKey = "HazliePerformanceMode"
  static let didChange = Notification.Name("io.intaglio.performanceModeDidChange")

  static var mode: PerformanceMode {
    get {
      guard let raw = UserDefaults.standard.string(forKey: defaultsKey),
            let mode = PerformanceMode.migrate(raw) else {
        // ~~return .godMode~~ on the reasoning that it preserved "the adaptive
        // high-performance behaviour installed before this control existed". It
        // did not: the behaviour before this control PAUSED background work on
        // battery. Defaulting to maximum was strictly more aggressive than
        // anything that had ever shipped, and it is what a FRESH INSTALL gets --
        // the run with the most work to do and the least standing to take the
        // whole machine.
        //
        // The downgrade concern in that comment is real and this accepts it: an
        // install that never opened Settings now runs gently. That is visible in
        // Settings, reversible in one click, and still finishes. A slow first
        // import is recoverable; a hot laptop on someone's first evening is the
        // impression that sticks.
        return .lessPower
      }
      return mode
    }
    set {
      UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey)
      NotificationCenter.default.post(name: didChange, object: nil)
    }
  }

  static var current: PowerBudget {
    mode == .fullSpeed ? .full : .trickle
  }

}

// SAFE IDLE-SLEEP PREVENTION.
//
// This uses macOS's power-management assertion API instead of spawning a
// long-lived `caffeinate` process. The assertion exists only while the setting
// is on AND the app reports finite work pending/running. It prevents idle
// system sleep; it does not block a manual sleep, shutdown, or closing the lid.
// The OS also drops it automatically if this process exits.
enum KeepMacAwake {
  static let defaultsKey = "HazlieKeepMacAwake"

  static var enabled: Bool {
    get { UserDefaults.standard.bool(forKey: defaultsKey) }
    set {
      UserDefaults.standard.set(newValue, forKey: defaultsKey)
      refresh(enabled: newValue, processing: processing)
    }
  }

  private static var processing = false
  private static var assertionID = IOPMAssertionID(0)

  static func update(processing next: Bool) {
    processing = next
    refresh(enabled: enabled, processing: next)
  }

  static func stop() {
    processing = false
    release()
  }

  private static func refresh(enabled: Bool, processing: Bool) {
    if enabled && processing {
      guard assertionID == 0 else { return }
      var next = IOPMAssertionID(0)
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypeNoIdleSleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "Intaglio Labs is processing local data" as CFString,
        &next
      )
      if result == kIOReturnSuccess {
        assertionID = next
      } else {
        NSLog("Intaglio Labs: could not keep Mac awake (IOKit \(result))")
      }
    } else {
      release()
    }
  }

  private static func release() {
    guard assertionID != 0 else { return }
    IOPMAssertionRelease(assertionID)
    assertionID = IOPMAssertionID(0)
  }
}
