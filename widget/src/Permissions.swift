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

enum Permissions {
  enum Status: String { case granted, denied, undetermined }

  // Held only while a request is in flight; see the comment at their use.
  private static var contactStore: CNContactStore?
  private static var eventStore: EKEventStore?

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

  // PHOTOS IS NOT ITS OWN ASK ANY MORE, and this is why.
  //
  // This used to call PHPhotoLibrary.requestAuthorization and show a row for it.
  // Nothing consumed the result. The photos CONNECTOR does not use PhotoKit at
  // all -- it reads Photos.sqlite, because PhotoKit has no people API (no
  // PHPerson, no PHFace, and no title or description on PHAsset; checked against
  // the SDK headers). Faces joined to person names are most of why photos are
  // worth reading here, so that connector cannot move the way calendar and
  // contacts did.
  //
  // Which left the app asking for a photo-library grant it never used, while the
  // data actually arrived through Full Disk Access -- one more permission on the
  // screen, buying nothing, for a feature already paid for elsewhere. MEASURED
  // rather than assumed: with the Photos grant reset and FDA still in place, the
  // connector opened and queried the library normally, where a denied read fails
  // the source loudly instead. So the ask is gone and photos rides in on the
  // grant that was always doing the work.
  //
  // If PhotoKit ever grows a people API this comes back, and photos leaves the
  // disk grant at the same time -- see photos.mjs.
  static func photos() -> Status {
    fullDisk()
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
    // TRIED AND REJECTED: raising the activation policy to .regular around the
    // request. The theory was that a TCC prompt is app-modal and needs a normal
    // app presence to attach to, which this LSUIElement app with only
    // borderless panels does not have. It made no difference — contacts went
    // from notDetermined (0) straight to denied (2) with nothing displayed,
    // exactly as before — so the Dock icon it flashed bought nothing and the
    // change is not kept. Recorded because the theory is a reasonable one to
    // have again.
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
      // THE STORE MUST OUTLIVE THE REQUEST.
      //
      // This was `CNContactStore().requestAccess(...)`, which creates a
      // temporary that is released the instant the call returns. The request
      // dies with it: the completion fires with false, no prompt is ever shown,
      // and TCC records nothing — so the UI said "denied" for a permission the
      // owner was never asked about, and the diagnostic showed the status still
      // sitting at notDetermined afterwards. Held in a static for the duration.
      //
      // A SECOND cause produces this EXACT symptom, so do not stop at this one:
      // if the matching hardened-runtime entitlement is missing, tccd refuses to
      // display the dialog and the completion fires false with the status
      // unmoved, indistinguishably. Check widget/Hazlie.entitlements before
      // suspecting lifetime again.
      contactStore = CNContactStore()
      contactStore?.requestAccess(for: .contacts) { ok, _ in
        contactStore = nil
        finish(ok ? .granted : .denied)
      }
    case "calendar":
      guard calendar() == .undetermined else { finish(calendar()); return }
      // Same lifetime rule. This one captured its store in the closure, which
      // usually survives — but "usually" is not a guarantee worth relying on
      // twice in one file.
      eventStore = EKEventStore()
      if #available(macOS 14.0, *) {
        eventStore?.requestFullAccessToEvents { ok, _ in
          eventStore = nil
          finish(ok ? .granted : .denied)
        }
      } else {
        eventStore?.requestAccess(to: .event) { ok, _ in
          eventStore = nil
          finish(ok ? .granted : .denied)
        }
      }
    case "photos":
      // No prompt of its own any more: photos comes in with Full Disk Access,
      // which has no request API and is opened as a settings pane instead.
      finish(photos())
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
  /// failing is what makes "intaglio labs" appear there, already listed, with a
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

  /// The raw authorization values, written where a person can read them.
  ///
  /// A permission that will not grant is nearly impossible to debug from the
  /// outside: TCC.db is itself protected, the system log is quiet about
  /// in-process denials, and the UI can only say "denied" without saying which
  /// kind. This records what each API actually returned, so the next person
  /// looking at "it just says open settings" has a fact to start from instead
  /// of a guess.
  static func writeDiagnostic() {
    let logs = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    let payload: [String: Any] = [
      "contacts_raw": CNContactStore.authorizationStatus(for: .contacts).rawValue,
      "calendar_raw": EKEventStore.authorizationStatus(for: .event).rawValue,
      "mapped": all,
      "bundle": Bundle.main.bundleIdentifier ?? "?",
      "path": Bundle.main.bundleURL.path,
      "active": NSApp.isActive,
      "at": ISO8601DateFormatter().string(from: Date()),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
    else { return }
    try? data.write(to: logs.appendingPathComponent("permissions.json"))
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
