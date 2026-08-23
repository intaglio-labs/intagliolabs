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

  static func contacts() -> Status {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return .granted
    case .notDetermined: return .undetermined
    default: return .denied
    }
  }

  static func calendar() -> Status {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .authorized, .fullAccess: return .granted
    case .notDetermined: return .undetermined
    default: return .denied
    }
  }

  static func photos() -> Status {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .authorized, .limited: return .granted
    case .notDetermined: return .undetermined
    default: return .denied
    }
  }

  /// Ask for one, by name. The completion carries the status AFTER the prompt.
  ///
  /// A prompt only ever appears once per app per permission — macOS remembers a
  /// denial and will not re-ask — so a caller that has already been refused is
  /// told `denied` immediately and should send the owner to Settings rather
  /// than pretending another press will do something.
  static func request(_ which: String, done: @escaping (Status) -> Void) {
    let finish: (Status) -> Void = { s in DispatchQueue.main.async { done(s) } }
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
    if let url = URL(string:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
      NSWorkspace.shared.open(url)
    }
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
