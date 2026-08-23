// The permissions an app can ask for properly, instead of sending someone to
// System Settings.
//
// Contacts, Calendar and Photos each have a real API with a real system prompt:
// one click, in context, naming this app. Messages and Notes have none — they
// are SQLite stores under ~/Library, so reading them means Full Disk Access,
// and there is no API that asks for it. That is the whole split, and it is
// macOS', not ours.
//
// These grants land on THIS APP, which only helps because the connectors daemon
// is now a child of it (Connectors.swift) and inherits the app's TCC identity.
// Under launchd it was node asking, and an app cannot request a prompt on behalf
// of a binary it does not own.
import Foundation
import AppKit
import Contacts
import EventKit
import Photos

enum Permissions {
  enum Status: String { case granted, denied, undetermined }

  // EVERY "PARTIAL YES" IS A YES.
  //
  // Recent macOS added narrower grants — Contacts can come back .limited,
  // Calendar .fullAccess or .writeOnly — and a switch that only accepted
  // .authorized read every one of them as a refusal. The UI then offered
  // "open settings" for a permission the owner had just granted, which is the
  // worst possible answer: it says the thing you did did not work.
  //
  // Written as: notDetermined means ask, denied and restricted mean denied,
  // and ANYTHING ELSE means we got something, so treat it as granted and let
  // the read find out what it actually covers.
  static func contacts() -> Status {
    let st = CNContactStore.authorizationStatus(for: .contacts)
    switch st {
    case .notDetermined: return .undetermined
    case .denied, .restricted: return .denied
    default: return .granted
    }
  }

  static func calendar() -> Status {
    let st = EKEventStore.authorizationStatus(for: .event)
    switch st {
    case .notDetermined: return .undetermined
    case .denied, .restricted: return .denied
    default: return .granted
    }
  }

  static func photos() -> Status {
    let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    switch st {
    case .notDetermined: return .undetermined
    case .denied, .restricted: return .denied
    default: return .granted
    }
  }

  /// Bring this app forward before asking.
  ///
  /// It is LSUIElement with non-activating panels, so it is frequently not the
  /// active app even while the owner is looking straight at it. A TCC prompt
  /// belongs to the requesting app and is presented in ITS context — from an
  /// inactive accessory app it can open behind whatever is in front, and a
  /// prompt nobody sees is a prompt nobody answers, which TCC eventually
  /// records as a refusal.
  private static func comeForward() {
    NSApp.activate(ignoringOtherApps: true)
  }

  /// Ask for one, by name. The completion carries the status AFTER the prompt.
  ///
  /// A prompt only ever appears once per app per permission — macOS remembers a
  /// denial and will not re-ask — so a caller that has already been refused is
  /// told `denied` immediately and should send the owner to Settings rather
  /// than pretending another press will do something.
  static func request(_ which: String, done: @escaping (Status) -> Void) {
    let finish: (Status) -> Void = { s in DispatchQueue.main.async { done(s) } }
    comeForward()
    switch which {
    case "contacts":
      guard contacts() == .undetermined else { finish(contacts()); return }
      CNContactStore().requestAccess(for: .contacts) { ok, _ in finish(ok ? .granted : .denied) }
    case "calendar":
      guard calendar() == .undetermined else { finish(calendar()); return }
      let store = EKEventStore()
      if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in finish(ok ? .granted : .denied) }
      } else {
        store.requestAccess(to: .event) { ok, _ in finish(ok ? .granted : .denied) }
      }
    case "photos":
      guard photos() == .undetermined else { finish(photos()); return }
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { st in
        finish(st == .authorized || st == .limited ? .granted : .denied)
      }
    default:
      finish(.denied)
    }
  }

  // MARK: Full Disk Access

  /// FDA has no query API, so the only honest test is to attempt a protected
  /// read and see what happens. `chat.db` is what the Messages connector opens,
  /// so this asks the exact question that matters rather than a proxy for it.
  ///
  /// AND THE ATTEMPT IS THE POINT, not just the answer. macOS adds an app to the
  /// Full Disk Access list the first time it touches a protected path — so this
  /// failing is what makes "Intaglio Labs" appear there, already listed, with a
  /// switch to flip. Without it the owner has to press +, walk a file picker to
  /// Applications, and find the app themselves.
  static func fullDisk() -> Status {
    let db = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Messages/chat.db")
    guard FileManager.default.fileExists(atPath: db.path) else {
      // No Messages history on this Mac: nothing to read, so nothing to grant.
      // Reported as granted rather than denied — a screen that demands a
      // permission which would buy nothing is just a wall.
      return .granted
    }
    guard let handle = try? FileHandle(forReadingFrom: db) else { return .denied }
    defer { try? handle.close() }
    // Opening can succeed where reading is refused; read a byte to be sure.
    return (try? handle.read(upToCount: 1)) != nil ? .granted : .denied
  }

  /// Nudge macOS into listing this app under Full Disk Access, then open the
  /// pane so the row is on screen with its switch off.
  static func primeFullDisk() {
    _ = fullDisk()
    openSettings("com.apple.preference.security?Privacy_AllFiles")
  }

  /// Open a System Settings pane AND put it in front.
  ///
  /// NSWorkspace.open on an x-apple.systempreferences: URL launches Settings but
  /// does not reliably raise it — from an accessory app that just activated
  /// itself, it opened behind the widget with no Dock icon to click and no way
  /// back to it. Opening the pane and then explicitly activating the Settings
  /// application is what actually puts it where the owner is looking.
  static func openSettings(_ pane: String) {
    guard let url = URL(string: "x-apple.systempreferences:\(pane)") else { return }
    NSWorkspace.shared.open(url)
    // Settings takes a moment to come up on a cold launch; try a few times
    // rather than once, and stop as soon as it is frontmost.
    var attempt = 0
    func raise() {
      attempt += 1
      let running = NSRunningApplication.runningApplications(
        withBundleIdentifier: "com.apple.systempreferences")
      if let app = running.first {
        app.activate(options: [.activateAllWindows])
        if app.isActive { return }
      }
      if attempt < 12 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { raise() }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { raise() }
  }

  static var all: [String: String] {
    [
      "contacts": contacts().rawValue,
      "calendar": calendar().rawValue,
      "photos": photos().rawValue,
      "fda": fullDisk().rawValue,
    ]
  }
}
