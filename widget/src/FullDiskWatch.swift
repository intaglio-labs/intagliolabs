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
//
// ~~"the daemon just started above"~~ / ~~"the daemon starts fresh"~~ were true
// of every launch until 2026-09-14, when the launch-time start became
// conditional — see main.swift, and the Calendar and Contacts dialogs it had
// been putting over onboarding screen 1. On a first run there may be no child
// here at all, and Connectors.restart() falls through to start() when nothing is
// running.
//
// ~~"That is deliberate, and it is in context. …the only place this app sends a
// first-run owner to move it is onboarding screen 2, the screen whose whole
// subject is these grants."~~ Round-1 review, finding 3: the screen is not what
// the owner is looking at. Granting Full Disk Access means going to System
// Settings, and the flow yields the scrim to send them there (see
// Bridge's openFullDiskAccess and FullDiskHelper) — so the app comes back to the
// front on the grant, this fires, a daemon starts against the `{}` config, and
// the Calendar and Contacts dialogs arrive over SYSTEM SETTINGS with no screen
// of ours on screen to have explained them. That is the same defect one step
// along, not an exception to it.
//
// So this RESPAWNS, which is what it was always for, and creates nothing. A
// first-run owner's reader starts from the press on screen 2's "next"
// (Bridge.startReadingSources) seconds later. What is kept from the live run of
// 2026-09-14 — grant at 12:16:35, Messages read at 12:17:52 — is the case that
// matters here: a daemon that was ALREADY running when the switch moved is still
// respawned at once, so it stops carrying a denial it has no reason to
// re-examine.
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
    //
    // THREE-STATE READ, ONE EDGE. Permissions.Status gained `unavailable` (a
    // Mac with no chat.db, reported as `.unavailable`), and the test that
    // matters here is unchanged by it:
    // only an actual successful read is `granted`, and only a transition INTO
    // that is worth respawning the daemon for. `unavailable -> granted` is a
    // real edge and fires deliberately — it means Messages was opened for the
    // first time and there is now a store the daemon's startup preflight has
    // never seen.
    guard now == .granted, let before = lastKnown, before != .granted else { return false }
    // A READER THAT EXISTS, OR AN OWNER WHO HAS BEEN ASKED. Connectors.restart()
    // starts a daemon when none is running, and on a first run that would put
    // the Calendar and Contacts dialogs over System Settings — which is where
    // the owner is standing at the exact moment this fires, because granting
    // Full Disk Access is a trip out of the app. The edge is still recorded (the
    // defer above), so nothing here re-fires later for the same grant; only the
    // respawn is skipped, and screen 2's "next" starts the reader in a moment.
    guard Connectors.shared.isRunning || Connectors.shared.mayStartAtLaunch else {
      NSLog("Intaglio Labs: full disk access arrived before setup did — leaving "
            + "the reader to onboarding rather than starting one here")
      return true
    }
    NSLog("Intaglio Labs: full disk access arrived — respawning connectors, not the app")
    Connectors.shared.restart()
    return true
  }
}
