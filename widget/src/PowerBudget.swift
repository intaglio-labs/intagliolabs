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
//   god mode      the machine-specific concurrency ceiling, and no rest between
//                 background passes
//   battery saver one summary at a time, and a rest between background passes
//
// ~~"small passes, utility priority"~~ neither was ever implemented. Grepping the
// tree for `battery_saver` found exactly ONE consumer -- the concurrency provider
// in hermes.mjs -- and ops/inference-profiles.json gives summaryConcurrency 1 to
// both `compact` and `balanced`, so on every Mac under 24 GB that provider
// resolved `battery_saver ? 1 : 1` and this entire setting did nothing. Measured
// on an 18 GB / 12-core machine, which is the machine it was added for.
//
// The rest interval is the lever that works at concurrency 1. A summary pass is
// ~90s of sustained GPU; once you cannot run fewer at a time, the only remaining
// control is not running them back to back.
//
// The selected mode is mirrored into a private runtime file because Hermes is
// a separate Node process and cannot read this app's UserDefaults domain.
enum PerformanceMode: String {
  case godMode = "god_mode"
  case batterySaver = "battery_saver"
}

enum PowerBudget {
  case full
  case trickle

  static let defaultsKey = "HazliePerformanceMode"
  static let didChange = Notification.Name("io.intaglio.performanceModeDidChange")

  static var mode: PerformanceMode {
    get {
      guard let raw = UserDefaults.standard.string(forKey: defaultsKey),
            let mode = PerformanceMode(rawValue: raw) else {
        // Preserve the adaptive high-performance behaviour installed before
        // this control existed. Battery Saver is an explicit choice, not a
        // surprise downgrade on upgrade.
        return .godMode
      }
      return mode
    }
    set {
      UserDefaults.standard.set(newValue.rawValue, forKey: defaultsKey)
      syncRuntimeFile()
      NotificationCenter.default.post(name: didChange, object: nil)
    }
  }

  static var current: PowerBudget {
    mode == .godMode ? .full : .trickle
  }

  private static var runtimeFile: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/performance-mode")
  }

  /// Keep Hermes and the app on one policy. The file contains one allow-listed
  /// word, is atomically replaced, and is owner-readable only.
  static func syncRuntimeFile() {
    let fm = FileManager.default
    let root = runtimeFile.deletingLastPathComponent()
    do {
      try fm.createDirectory(at: root, withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
      try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
      try Data("\(mode.rawValue)\n".utf8).write(to: runtimeFile, options: .atomic)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: runtimeFile.path)
    } catch {
      NSLog("Intaglio Labs: could not store performance mode: \(error.localizedDescription)")
    }
  }

  /// Kept as the supervisor's launch hook. There are deliberately no power or
  /// thermal observers now: those signals no longer change the policy.
  static func startWatching() {
    syncRuntimeFile()
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
