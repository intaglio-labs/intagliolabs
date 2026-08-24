import AppKit
import Foundation

// NOTICES FULL DISK ACCESS ARRIVING, and respawns the one process that needs
// anything to happen at all.
//
// THE PROBLEM THIS SOLVES IS TWO RESTARTS FOR ONE GRANT. macOS offers "Quit &
// Reopen" whenever the switch moves for a running app, so the owner is asked to
// restart — and then the app looked like it restarted anyway, which reads as
// either a crash or a second restart nobody asked for.
//
// THIS APP DOES NOT NEED TO RESTART. Permissions.fullDisk() is a real read of
// chat.db, not a database lookup, and it starts SUCCEEDING IN THIS PROCESS the
// moment the switch flips — see FullDiskHelper, which turns its card green off
// exactly that signal without relaunching anything. macOS's offer is generic
// advice for apps that cache their access; the access here is a file open.
//
// The connectors daemon is the part that is genuinely stale, and it is a
// separate process: it ran its startup preflight once at spawn and recorded the
// denial. It does not need the APP to restart either — only itself. So that
// child is respawned and nothing else is.
//
// WHICH MAKES BOTH OF THE OWNER'S PATHS LAND IN THE SAME PLACE, which is the
// whole point:
//
//   Take macOS up on "Quit & Reopen" — the app relaunches, onboarding resumes on
//   its recorded step (see Bridge.onboardingStep), the daemon starts fresh, and
//   the transition never registers here because a fresh launch is already
//   granted. Nothing double-fires.
//
//   Dismiss it and come back to the app — no restart happened, so
//   didBecomeActive brings us here and the daemon is respawned in place.
//
// Neither path restarts twice, and neither leaves the daemon sitting on a denial
// it will not retry.
enum FullDiskWatch {
  /// What the last look said, so only the DENIED -> GRANTED edge acts. Nil until
  /// begin() takes the first reading.
  private static var lastKnown: Permissions.Status?

  /// Start watching. Takes a baseline first: an app launched with the grant
  /// already in place has no transition to react to, and respawning a daemon
  /// that just started correctly would be a restart loop wearing a helpful face.
  static func begin() {
    lastKnown = Permissions.fullDisk()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { _ in check() }
  }

  /// Re-probe and respawn the daemon if the grant arrived since the last look.
  /// Safe to call from anywhere, as often as you like — it acts on the edge, not
  /// on the state. Returns whether this call was the one that saw it land.
  @discardableResult
  static func check() -> Bool {
    let now = Permissions.fullDisk()
    defer { lastKnown = now }
    // `lastKnown == nil` means begin() never ran, and a first reading is a
    // baseline rather than an edge.
    guard now == .granted, let before = lastKnown, before != .granted else { return false }
    NSLog("Intaglio Labs: full disk access arrived — respawning connectors, not the app")
    Connectors.shared.restart()
    return true
  }
}
