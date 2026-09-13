import AppKit
import Foundation
import UserNotifications

// THE FILE FINDS YOU.
//
// LinkedIn will not let anything read your connections, so the whole feature
// rests on the owner asking LinkedIn for a copy and then, some unknown number
// of minutes or hours later, handing the resulting file over. Screen 4 can ask
// for it; it cannot wait for it. The archive lands in ~/Downloads while the
// owner is doing something else entirely, and the one thing guaranteed not to
// happen is that they reopen a setup flow they finished this morning to press
// "i have it".
//
// So this watches the two folders a download lands in and says something when
// one appears. The press on the notification imports it through exactly the
// same path as the picker -- Bridge.importLinkedIn(files:) -> acceptLinkedInFiles
// -- so the header check, the vintage refusal and the atomic swap all still
// happen. There is no second, looser import.
//
// WHAT IT WILL NOT DO:
//
//   Import anything on its own. A file appearing in Downloads is not consent to
//   read it; the notification is an offer and the press is the answer. There is
//   no "auto-import" branch anywhere in this file.
//
//   Read the contents of anything it has not been told to. The scan looks at
//   FILE NAMES in two directories and nothing else. What is inside a candidate
//   is read only after the owner presses import, by the import.
//
//   Keep running once there is an export. The watcher exists to close one gap:
//   the owner has asked LinkedIn for a file and does not have it yet. The moment
//   they do, it stops -- see stop(), and the check at the top of scan().
//
// THE TCC PROMPT IS THE COST. The first read of ~/Downloads or ~/Desktop makes
// macOS ask the owner whether this app may see that folder, and it asks at
// whatever moment the watcher starts rather than in response to something they
// did. That was weighed and accepted: the alternative is a feature that only
// works for owners who remember to come back. A denial is handled in silence --
// the directory simply never opens, this file does nothing for the rest of the
// run, and the picker on screen 4 and in settings is unaffected.
final class ExportWatch: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ExportWatch()

  /// The notification the owner can answer, and the one button on it.
  private static let category = "io.intaglio.linkedin-export"
  private static let importAction = "import"
  /// Where the candidate's path travels from the banner to the press.
  private static let pathKey = "path"

  private weak var bridge: Bridge?
  /// EVERYTHING BELOW THIS LINE IS THE QUEUE'S. The event handlers run there,
  /// the scan runs there and stop() runs there, so the watch list is built there
  /// too — begin() setting it up on main while a handler was already firing on
  /// the queue is a race for the sake of two lines.
  private var sources: [DispatchSourceFileSystemObject] = []
  private let queue = DispatchQueue(label: "io.intaglio.exportwatch", qos: .utility)
  /// Paths already offered this run. A directory event fires for every write,
  /// and a folder that already holds an export would otherwise produce one
  /// notification per unrelated download for the rest of the session.
  private var offered: Set<String> = []
  private var started = false
  private var rescan: DispatchWorkItem?

  /// The two folders a browser puts a download in. Desktop is here because
  /// Safari's "save to" is per-download and plenty of people keep it there.
  private static var watched: [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [home.appendingPathComponent("Downloads", isDirectory: true),
            home.appendingPathComponent("Desktop", isDirectory: true)]
  }

  /// Start watching, unless there is nothing to wait for.
  ///
  /// The installed-export check is the gate, and it is checked HERE rather than
  /// only in the callback: an owner who imported an export months ago should
  /// never see the Downloads prompt at all, because for them this feature has
  /// nothing to offer.
  func begin(bridge: Bridge) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !started else { return }
    guard !Bridge.linkedInExportInstalled else { return }
    self.bridge = bridge
    started = true

    // The delegate and the category both have to exist before a notification
    // naming the category is sent, or the banner arrives with no button on it.
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let action = UNNotificationAction(
      identifier: Self.importAction, title: "import", options: [])
    center.setNotificationCategories([
      UNNotificationCategory(identifier: Self.category, actions: [action],
                             intentIdentifiers: [], options: [])
    ])

    queue.async { [weak self] in
      guard let self else { return }
      for directory in Self.watched { self.watch(directory) }
      // One look now: the archive may well have landed while the app was not
      // running, or during the setup flow the owner just finished.
      self.scan()
    }
  }

  /// Stop for good. Called when an export lands, by whichever route.
  func stop() {
    queue.async { [weak self] in
      guard let self else { return }
      self.rescan?.cancel()
      self.rescan = nil
      // Each source closes its own descriptor in its cancel handler; see
      // watch(). Closing them here as well would close a number the kernel may
      // already have handed to something else.
      for source in self.sources { source.cancel() }
      self.sources = []
    }
  }

  private func watch(_ directory: URL) {
    dispatchPrecondition(condition: .onQueue(queue))
    // O_EVTONLY is the "I want events, not contents" open. It is still an open,
    // and it is the call that trips the Downloads/Desktop consent prompt.
    let fd = open(directory.path, O_EVTONLY)
    guard fd >= 0 else {
      // Denied, or the folder does not exist. Silent on purpose: there is
      // nothing the owner can usefully do about it from here, and the pickers
      // on screen 4 and in settings still work.
      NSLog("Intaglio Labs: not watching \(directory.lastPathComponent) for a LinkedIn export")
      return
    }
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fd, eventMask: [.write, .delete, .rename], queue: queue)
    source.setEventHandler { [weak self] in self?.scheduleScan() }
    source.setCancelHandler { close(fd) }
    source.resume()
    sources.append(source)
  }

  /// A download writes a directory many times over. Coalesce: one scan a few
  /// seconds after the LAST event, never one per write.
  ///
  /// That delay is also the only quiescence signal available. Offering an
  /// archive that is still downloading gets the owner "i couldn't open that zip"
  /// about a perfectly good file — and the obvious guard, refusing anything
  /// modified in the last few seconds, deadlocks: the last write is what
  /// schedules the scan, so the file is too young at every scan it will ever
  /// get, and nothing writes again to re-arm one. Waiting out the quiet
  /// terminates and still re-arms on the next write.
  private static let settleSeconds = 3.0

  private func scheduleScan() {
    dispatchPrecondition(condition: .onQueue(queue))
    rescan?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.scan() }
    rescan = work
    queue.asyncAfter(deadline: .now() + Self.settleSeconds, execute: work)
  }

  /// NAMES ONLY. Nothing here opens a candidate; the import does that, after a
  /// press. `contentsOfDirectory` is the read the consent prompt is about.
  private func scan() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !sources.isEmpty else { return }
    // An export can land without this watcher: the picker on screen 4, the
    // settings row, a file dropped on the panel. Each of those is a reason to
    // stop, and this is the check that notices.
    if Bridge.linkedInExportInstalled { stop(); return }
    let fm = FileManager.default
    for directory in Self.watched {
      guard let names = try? fm.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants])
      else { continue }
      // Newest first, so the owner is offered the download they just made
      // rather than whichever one the filesystem happened to list first.
      let candidates = names
        .filter { Self.looksLikeExport($0.lastPathComponent) }
        .filter { !offered.contains($0.path) }
        .sorted { a, b in
          let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate) ?? .distantPast
          let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate) ?? .distantPast
          return da > db
        }
      for found in candidates {
        // A part-downloaded file is named `.crdownload`/`.download`/`.part` and
        // does not match above, but a zero-byte placeholder under the FINAL name
        // is a thing some clients create. Nothing to offer until there is
        // something in it — and it is not marked as offered either, so the scan
        // after the next write picks it up.
        let size = (try? found.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { continue }
        offered.insert(found.path)
        offer(found)
        // ONE OFFER AT A TIME. Two banners for two files in the same folder is
        // an inbox, not an offer, and the second is nearly always the browser's
        // duplicate download of the first.
        return
      }
    }
  }

  /// The names LinkedIn's export actually arrives under.
  ///
  /// The archive is `Complete_LinkedInDataExport_<stamp>.zip` or
  /// `Basic_LinkedInDataExport_<stamp>.zip` -- "Basic" is the partial one
  /// LinkedIn sends within minutes and "Complete" the full archive that can take
  /// a day, and Connections is in both. A bare `Connections.csv` is here for the
  /// owner who has already unzipped one, including the browser's second copy
  /// (`Connections (1).csv`).
  ///
  /// Matched loosely on the archive and EXACTLY on the CSV: `LinkedInDataExport`
  /// in a zip's name is unambiguous, where "connections" on its own is a word
  /// that turns up in unrelated files.
  static func looksLikeExport(_ name: String) -> Bool {
    let lower = name.lowercased()
    if lower.hasSuffix(".zip") { return lower.contains("linkedindataexport") }
    guard lower.hasSuffix(".csv") else { return false }
    let stem = String(lower.dropLast(4))
    if stem == "connections" { return true }
    // `Connections (1).csv`, which is what a second download is called.
    guard stem.hasPrefix("connections (") , stem.hasSuffix(")") else { return false }
    let digits = stem.dropFirst("connections (".count).dropLast()
    return !digits.isEmpty && digits.allSatisfy { $0.isNumber }
  }

  /// AN OFFER, NOT AN IMPORT. The file is named so the owner can tell whether it
  /// is the one they were expecting, and nothing is read until they answer.
  private func offer(_ url: URL) {
    ModelSetup.notify(
      title: "found your LinkedIn export",
      body: "\(url.lastPathComponent) — import it?",
      category: Self.category,
      userInfo: [Self.pathKey: url.path])
  }

  // MARK: the press

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    defer { completionHandler() }
    let info = response.notification.request.content.userInfo
    guard let path = info[Self.pathKey] as? String, !path.isEmpty else { return }
    // The button, or the banner itself. Tapping the body of an offer is the
    // same yes as pressing its one button -- there is nothing else this
    // notification could mean -- but a dismissal is not, and must import
    // nothing.
    let identifier = response.actionIdentifier
    guard identifier == Self.importAction
            || identifier == UNNotificationDefaultActionIdentifier else { return }
    guard let bridge else { return }
    bridge.importLinkedIn(files: [URL(fileURLWithPath: path)]) { [weak self] out in
      self?.report(out)
    }
  }

  /// Present the banner even while this app is frontmost. It is LSUIElement, so
  /// that is rare -- but a settings panel open at the moment the file lands is
  /// exactly when the owner is thinking about this.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  /// WHAT HAPPENED, in the same words the screens use. An import the owner
  /// started from a banner has no screen to answer on, and a press that
  /// silently does nothing is worse than no banner at all.
  private func report(_ out: [String: Any]) {
    let state = out["state"] as? String
    if state == "ok" {
      let n = out["connections"] as? Int ?? 0
      ModelSetup.notify(
        title: "LinkedIn export imported",
        body: n > 0 ? "\(n.formatted()) connections." : "imported.")
      stop()
      return
    }
    guard state == "error" else { return }
    let file = out["file"] as? String ?? ""
    let why: String
    switch out["reason"] as? String {
    case "zip-connections":
      why = "there is no Connections.csv in that zip — ask LinkedIn for \"Connections\"."
    case "zip": why = "i couldn't open that zip."
    case "columns": why = "i don't recognise that file's columns — i can only read the english export."
    case "newer": why = "you already have a newer \(file) — i kept the one you have."
    case "duplicate": why = "there are two of those — open settings and choose one."
    default: why = "i couldn't read that file."
    }
    ModelSetup.notify(title: "couldn't import that", body: why)
  }
}
