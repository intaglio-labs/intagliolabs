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
// THE TCC PROMPT IS THE COST, AND WHEN IT ARRIVES IS THE WHOLE OF IT. The first
// read of ~/Downloads or ~/Desktop makes macOS ask whether this app may see that
// folder.
//
// ~~"it asks at whatever moment the watcher starts rather than in response to
// something they did. That was weighed and accepted."~~ What was accepted was
// not what shipped: begin() ran from applicationDidFinishLaunching, so on a
// first run both dialogs arrived over onboarding screens 1 to 3 — with no
// context, before anything had mentioned an export, and while screen 2 is
// telling its own story about a different grant with a different dialog (review
// finding 2, 2026-09-13). It is asked FOR something now: screen 4's "request a
// copy" or "later" arms it, and a launch arms it only for an owner already past
// the flow. See begin().
//
// A denial is still silent -- there is nothing the owner can usefully do about
// it from here and both pickers work regardless -- but it is no longer
// permanent: `watching` stays false, so the next arming tries again, and macOS
// answers a denied folder without a second dialog.
final class ExportWatch: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ExportWatch()

  /// The notification the owner can answer, and the one button on it.
  private static let category = "io.intaglio.linkedin-export"
  private static let importAction = "import"
  /// Where the candidate's path travels from the banner to the press.
  private static let pathKey = "path"

  /// What the owner has already been asked about, kept across launches.
  ///
  /// ~~A per-process Set~~ (review finding 12): an owner who let the banner go,
  /// or who keeps an unrelated `Connections.csv` on their Desktop, met the same
  /// offer at every launch for the rest of the install's life. Ignoring an offer
  /// is an answer and it has to stick.
  private static let offeredDefaultsKey = "HazlieLinkedInOffered"

  /// WHEN THIS OWNER STARTED WAITING, and how long the waiting may last.
  ///
  /// An owner who pressed "later" and never imports was enumerated over two
  /// folders every sixty seconds, on every launch, for the life of the install
  /// -- while hermes tells that same owner "your linkedin export never arrived"
  /// after seven days. Two parts of one feature disagreeing about whether the
  /// wait ever ends.
  ///
  /// Twice the sentence's bound, deliberately: seven days is when the CARD
  /// stops promising, and an owner who requested the archive late in that week
  /// should still have it taken when it lands. After a fortnight the pickers
  /// are the way in, and they always were.
  private static let armedDefaultsKey = "HazlieLinkedInWatchArmed"
  private static let giveUpAfter: TimeInterval = 14 * 24 * 60 * 60

  private weak var bridge: Bridge?
  /// EVERYTHING BELOW THIS LINE IS THE QUEUE'S. The event handlers run there,
  /// the scan runs there and stop() runs there, so the watch list is built there
  /// too — begin() setting it up on main while a handler was already firing on
  /// the queue is a race for the sake of two lines.
  private var sources: [DispatchSourceFileSystemObject] = []
  private let queue = DispatchQueue(label: "io.intaglio.exportwatch", qos: .utility)
  /// What a candidate looked like when it was measured, so "still growing" can
  /// be answered without a directory event that is never coming. See scan().
  private var seen: [String: (size: Int, at: Date?)] = [:]
  /// Whether a folder is actually open. NOT "begin() has been called": a denied
  /// folder used to leave this true forever, so granting it later in System
  /// Settings did nothing until the app was relaunched — while screen 4 went on
  /// promising to take the file when it arrived (review finding 2).
  private var watching = false
  /// Refused for good — the registry has linkedin off, or an export is already
  /// installed. Different from `watching`, which a later attempt may retry.
  private var finished = false
  /// The didBecomeActive observer, registered once. See begin().
  private var activation: NSObjectProtocol?
  /// The bridge to re-arm with, kept because a retry has no caller to pass one.
  private weak var armedBridge: Bridge?
  /// THE OFFER ON SCREEN, or nil. While this is set nothing new is offered:
  /// across scans the sweep used to find the next archive, overwrite the
  /// pending one and repaint the open panel, so the filename changed under the
  /// owner's cursor and a click could import a file other than the name they
  /// read.
  private var offering: String?
  /// Answered "not now" this session. In memory and cleared when the owner
  /// comes back to the app, which is what makes ✕ a deferral rather than a
  /// refusal: it stops the sweep re-presenting the same archive every minute,
  /// and the next activation offers it again.
  private var deferred: Set<String> = []
  /// How many times in a row a path has been found still growing. See
  /// settleAgain: without this, a file that never settles re-enumerates both
  /// folders every three seconds for as long as it keeps changing.
  private var attempts: [String: Int] = [:]
  private var rescan: DispatchWorkItem?
  /// The slow sweep, for a change no directory event describes. See armSweep.
  private var sweep: DispatchWorkItem?

  /// The two folders a browser puts a download in. Desktop is here because
  /// Safari's "save to" is per-download and plenty of people keep it there.
  private static var watched: [URL] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return [home.appendingPathComponent("Downloads", isDirectory: true),
            home.appendingPathComponent("Desktop", isDirectory: true)]
  }

  /// Start watching, if this owner has anything to wait for.
  ///
  /// WHEN THIS MAY BE CALLED IS THE WHOLE FINDING. `open(O_EVTONLY)` below is
  /// what makes macOS ask the owner for their Downloads and Desktop folders, and
  /// it used to be called from applicationDidFinishLaunching — so on a first
  /// run the two system dialogs arrived over onboarding screens 1 to 3, with no
  /// context, while screen 2 is telling its own story about a DIFFERENT grant
  /// with a different dialog, and before anyone had mentioned an export (review
  /// finding 2). It is now reached from two places, and both mean the owner has
  /// just been told what the file is:
  ///
  ///   screen 4, when they press "request a copy" or "later"
  ///   launch, but only for an owner who has already finished the flow
  ///
  /// THREE REFUSALS, and two of them are permanent:
  ///
  ///   the registry has `connectors.linkedin` off, so this install does not run
  ///   that connector at all — the same flag that hides its tile. Asking such an
  ///   owner for a folder on its behalf, and then offering imports for a source
  ///   nothing reads, is work nobody asked for (review finding 3).
  ///
  ///   an export is already installed, so there is nothing to wait for.
  ///
  ///   ...and `watching`, which is NOT permanent. A denied folder must leave
  ///   this retryable, or granting it later in System Settings does nothing
  ///   until the app is relaunched.
  func begin(bridge: Bridge) {
    dispatchPrecondition(condition: .onQueue(.main))
    self.armedBridge = bridge
    // REGISTERED BEFORE THE REFUSALS, because the refusals are what it exists to
    // retry: a folder the owner grants later in System Settings, and a registry
    // the owner switches linkedin back on in. Both happen while this app is in
    // the background, and coming back to it is when they have just happened.
    if activation == nil {
      activation = NotificationCenter.default.addObserver(
        forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.rearm() }
    }
    guard !finished, !watching else { return }
    // RETRYABLE, NOT PERMANENT (review finding 12). The registry is mutable at
    // runtime -- the settings shelf switches this connector on and off -- so a
    // refusal on it must not outlive the setting that caused it. The one
    // permanent refusal is an export that is already installed, which is the
    // only condition here that cannot revert.
    guard Features.connector("linkedin") != .off else { return }
    guard !Bridge.linkedInExportInstalled else { finished = true; return }
    // AND THE WAIT HAS AN END. See giveUpAfter.
    let armedAt = UserDefaults.standard.double(forKey: Self.armedDefaultsKey)
    if armedAt <= 0 {
      UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.armedDefaultsKey)
    } else if Date().timeIntervalSince1970 - armedAt > Self.giveUpAfter {
      finished = true
      return
    }
    self.bridge = bridge
    // CLAIMED HERE, ON THE MAIN THREAD, BEFORE THE BLOCK THAT BLOCKS (review
    // finding 14). The queue block below parks inside open(O_EVTONLY) for as
    // long as the consent dialog is on screen, so assigning `watching` from
    // inside it left a window in which a second arm -- press "request a copy",
    // answer the dialog slowly, come back and press "later" -- walked past the
    // guard and opened a second source per folder. Given back below if nothing
    // actually opened.
    watching = true

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
      // OPENED, NOT MERELY ATTEMPTED. Both folders denied means this call
      // achieved nothing, and the next trigger — the owner coming back from
      // System Settings, or the next launch — gets to try again. macOS asks
      // once and then answers a denial without a dialog, so a retry costs the
      // owner no second prompt.
      let opened = self.sources.isEmpty == false
      DispatchQueue.main.async { self.watching = opened }
      guard opened else { return }
      // One look now: the archive may well have landed while the app was not
      // running, or while the owner was in the browser asking for it.
      self.scan()
      self.armSweep()
    }

    // AND WHENEVER THE OWNER COMES BACK. They have most likely just been in the
    // browser downloading the thing this is waiting for, and a file that changed
    // without the folder changing produces no event at all — see armSweep.
    // Registered once, with the watcher, and harmless after stop(): scan()
    // returns immediately with no sources.
    if activation == nil {
      activation = NotificationCenter.default.addObserver(
        forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.queue.async { self?.scan() }
      }
    }
  }

  /// Stop for good. Called when an export lands, by whichever route.
  func stop() {
    DispatchQueue.main.async { [weak self] in
      self?.finished = true
      self?.watching = false
    }
    queue.async { [weak self] in
      guard let self else { return }
      self.rescan?.cancel()
      self.rescan = nil
      self.sweep?.cancel()
      self.sweep = nil
      // Each source closes its own descriptor in its cancel handler; see
      // watch(). Closing them here as well would close a number the kernel may
      // already have handed to something else.
      for source in self.sources { source.cancel() }
      self.sources = []
      self.seen = [:]
    }
  }

  /// Try again, from the outside. Coming back to the app is when a denied folder
  /// has just been granted, or the registry just switched this connector on --
  /// and it is also when an offer the owner put off with ✕ may be made again.
  private func rearm() {
    dispatchPrecondition(condition: .onQueue(.main))
    queue.async { [weak self] in self?.deferred = [] }
    guard let bridge = armedBridge else { return }
    if watching {
      queue.async { [weak self] in self?.scan() }
      return
    }
    begin(bridge: bridge)
  }

  /// THE OWNER ANSWERED. `keep` is what spends the offer.
  ///
  /// ~~The key was written when the offer was MADE~~, which spent it on an
  /// offer drawn under the onboarding scrim, on an import that failed, and on a
  /// ✕ -- three ways to lose an archive for the life of the install, on the one
  /// path whose whole purpose is not to lose it. It is written by the two
  /// answers that actually end an offer: an import that worked, and "not this
  /// one". A failure and a "not now" leave it exactly where it was.
  func answerOffer(_ key: String, keep: Bool) {
    queue.async { [weak self] in
      guard let self else { return }
      if keep { Self.rememberOffer(key) } else { self.deferred.insert(key) }
      self.offering = nil
      self.attempts[key] = nil
      // An import that worked installs an export, and that is the end of this
      // watcher -- scan() notices, and says so rather than leaving it to luck.
      self.scan()
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

  /// AND A LOOK THAT DOES NOT WAIT FOR AN EVENT AT ALL.
  ///
  /// A directory source fires when the directory's CONTENTS change. Touching a
  /// file in it does not: the entry is still there under the same name, so the
  /// vnode is untouched and nothing wakes this class. Live on the recorded run
  /// — an archive already offered was touched, which changed its mtime and so
  /// its offer key, and it was never offered again. The key was right; no scan
  /// ever ran to evaluate it.
  ///
  /// So there are two more ways in. Coming back to the app is the moment the
  /// owner is most likely to have just downloaded something, and a slow sweep
  /// covers the Mac nobody activates this app on for hours. Neither reads
  /// anything a directory event would not have.
  private static let sweepSeconds = 60.0

  private func armSweep() {
    dispatchPrecondition(condition: .onQueue(queue))
    sweep?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.scan()
      // Re-armed from the tail rather than a repeating timer, so a scan that
      // stopped the watcher does not leave a timer firing into a dead object.
      if !self.sources.isEmpty { self.armSweep() }
    }
    sweep = work
    queue.asyncAfter(deadline: .now() + Self.sweepSeconds, execute: work)
  }

  private func scheduleScan() {
    dispatchPrecondition(condition: .onQueue(queue))
    rescan?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.scan() }
    rescan = work
    queue.asyncAfter(deadline: .now() + Self.settleSeconds, execute: work)
  }

  /// What an offer is remembered by.
  ///
  /// ~~The path alone~~ (review finding 4). The path went into the set BEFORE
  /// the import ran and no failure took it out, so a file offered while it was
  /// still downloading — the import answering "i couldn't open that zip" — was
  /// burnt for the rest of the install. Size and date as well: the same archive
  /// finishing its download is a different thing to offer, and an unchanged file
  /// is still only offered once.
  private static func offerKey(_ url: URL, size: Int, at: Date?) -> String {
    "\(url.path)|\(size)|\(at.map { String(Int($0.timeIntervalSince1970)) } ?? "-")"
  }

  /// AN ORDERED LIST, NEWEST LAST.
  ///
  /// ~~A Set, trimmed with `suffix(200)`~~ — `Set.suffix` takes 200 of an
  /// UNORDERED collection, so once the list filled up, which of the owner's
  /// answers survived a relaunch was whatever the hash seed decided that day.
  /// Bounded it must be — a Downloads folder nobody tidies would grow this
  /// forever — but the thing to drop is the oldest answer, not an arbitrary one.
  private static var offeredKeys: [String] {
    get { UserDefaults.standard.stringArray(forKey: offeredDefaultsKey) ?? [] }
    set { UserDefaults.standard.set(Array(newValue.suffix(200)), forKey: offeredDefaultsKey) }
  }

  private static func rememberOffer(_ key: String) {
    var keys = offeredKeys
    guard !keys.contains(key) else { return }
    keys.append(key)
    offeredKeys = keys
  }

  /// Look again shortly, with no directory event to ride on.
  ///
  /// WRITING BYTES INTO AN EXISTING FILE DOES NOT TOUCH THE DIRECTORY VNODE, so
  /// for any client that creates the final name and then fills it (curl -o, and
  /// some app downloaders) there is exactly ONE event: the create. The settle
  /// timer fires three seconds later, the file is still growing, and no further
  /// event is ever coming to correct it. This is how the scan gets to look
  /// again at a file it has decided not to judge yet.
  /// How many times in a row one path may be found still growing before this
  /// stops chasing it. Twenty settles is a minute of three-second scans, which
  /// is generous for a file that is genuinely being written and finite for one
  /// that is not: a stalled download, or a Connections.csv some other tool keeps
  /// rewriting, used to re-enumerate both folders every three seconds for as
  /// long as it lasted and offer nothing at all. The sixty-second sweep still
  /// looks, so a file that settles later is still found.
  private static let settleAttempts = 20

  private func settleAgain(for path: String) {
    dispatchPrecondition(condition: .onQueue(queue))
    let tries = (attempts[path] ?? 0) + 1
    attempts[path] = tries
    guard tries <= Self.settleAttempts else { return }
    scheduleScan()
  }

  /// NAMES AND SIZES ONLY. Nothing here opens a candidate; the import does that,
  /// after a press. `contentsOfDirectory` is the read the consent prompt is
  /// about.
  private func scan() {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !sources.isEmpty else { return }
    // An export can land without this watcher: the picker on screen 4, the
    // settings row, a file dropped on the panel. Each of those is a reason to
    // stop, and this is the check that notices.
    if Bridge.linkedInExportInstalled { stop(); return }
    // AN OFFER ON SCREEN IS A REASON TO FIND NOTHING NEW (review finding 5).
    // "One offer at a time" held only inside a single pass of this function;
    // across scans the sweep found the next archive and repainted the panel the
    // owner was reading, so the filename changed under their cursor and a click
    // could import something other than the name they had just read.
    guard offering == nil else { return }
    let fm = FileManager.default
    let already = Set(Self.offeredKeys)
    for directory in Self.watched {
      guard let names = try? fm.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants])
      else { continue }
      // Newest first, so the owner is offered the download they just made
      // rather than whichever one the filesystem happened to list first.
      let candidates = names
        .compactMap { Self.candidate(at: $0) }
        .sorted { a, b in (a.at ?? .distantPast) > (b.at ?? .distantPast) }
      for found in candidates {
        let size = (try? found.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        // A part-downloaded file is usually named `.crdownload`/`.download`/
        // `.part` and never matches at all, but a placeholder under the FINAL
        // name is a thing some clients create.
        guard size > 0 else { settleAgain(for: found.url.path); continue }
        // STILL GROWING? Measured against the last look rather than against the
        // clock: a file whose size has not moved since the previous scan has
        // stopped being written, and one that has moved gets another settle.
        // Neither is marked offered, so nothing is spent on a partial file.
        //
        // THE DATE IS PART OF "THE SAME FILE" (review finding 15). Keyed on the
        // path with a size alone, a download deleted and fetched again from the
        // same server matched the OLD entry on its first scan -- same path, same
        // size -- passed the settle check immediately, and was offered while it
        // was still being written, with a new mtime that made the offer key new.
        // The whole guard, spent on a partial file.
        let previous = seen[found.url.path]
        seen[found.url.path] = (size, found.at)
        guard let previous, previous.size == size, previous.at == found.at else {
          settleAgain(for: found.url.path)
          continue
        }
        let key = Self.offerKey(found.url, size: size, at: found.at)
        guard !already.contains(key), !deferred.contains(key) else { continue }
        // NOT RECORDED HERE. See answerOffer: the key is written by the answer,
        // because an offer nobody saw, an import that failed and a ✕ all used to
        // spend it.
        offering = key
        offer(found.url, vintage: found.at, in: directory, key: key)
        // ONE OFFER AT A TIME. Two banners for two files in the same folder is
        // an inbox, not an offer, and the second is nearly always the browser's
        // duplicate download of the first.
        return
      }
    }
  }

  /// A thing in a watched folder that might be the export, and when it is from.
  ///
  /// SAFARI EXPANDS THE ARCHIVE (review finding 6). With "open safe files after
  /// downloading" on — which is the default — what lands is a FOLDER,
  /// `Complete_LinkedInDataExport_x/`, and the watcher was blind to it: the
  /// folder has no extension to match and `.skipsSubdirectoryDescendants` hid
  /// the CSV inside it. For the default Safari configuration that was the whole
  /// feature dark. A matching folder is answered with the Connections.csv inside
  /// it, which is a file the import already knows how to take.
  private static func candidate(at url: URL) -> (url: URL, at: Date?)? {
    let values = try? url.resourceValues(
      forKeys: [.isDirectoryKey, .contentModificationDateKey])
    let at = values?.contentModificationDate
    if values?.isDirectory == true {
      guard looksLikeExportFolder(url.lastPathComponent) else { return nil }
      let inside = url.appendingPathComponent("Connections.csv")
      guard FileManager.default.fileExists(atPath: inside.path) else { return nil }
      // The CSV's own date, not the folder's: the folder's changes when
      // anything in it does, and the vintage refusal downstream is about the
      // export.
      let insideAt = (try? inside.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      return (inside, insideAt ?? at)
    }
    guard looksLikeExport(url.lastPathComponent) else { return nil }
    return (url, at)
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

  /// The FOLDER Safari leaves when it expands the archive for you. Same name as
  /// the zip without the extension, so the same unambiguous substring decides
  /// it — a directory called `Downloads` or `Connections` is not this.
  static func looksLikeExportFolder(_ name: String) -> Bool {
    name.lowercased().contains("linkedindataexport")
  }

  /// AN OFFER, NOT AN IMPORT. The file is named so the owner can tell whether it
  /// is the one they were expecting, and nothing is read until they answer.
  ///
  /// ...AND DATED, WHICH IS NOT DECORATION (review finding 11). The `newer`
  /// refusal inside the import only compares a pick against an INSTALLED export,
  /// and a fresh Mac has none — so a year-old archive left in Downloads imports
  /// on one press and the connector ingests a year-old graph as current. It
  /// cannot be refused outright, because an owner restoring a Mac may well mean
  /// it, so the date rides the offer and the press is an informed one.
  ///
  /// Today's download says nothing, because "found your export, from today" is
  /// noise on the one case this is really for.
  ///
  /// IN THE APP FIRST, AND THE BANNER SECOND.
  ///
  /// ~~This was a UNUserNotification and nothing else.~~ Live on the recorded
  /// run: three archives found, three offers written into the defaults, and no
  /// banner ever shown — before or after the owner allowed notifications, with
  /// nothing from usernotifications in the system log for the bundle. Whatever
  /// is wrong on that Mac is on the far side of an API this app cannot see
  /// into, and that is exactly why it cannot be the only output: a feature whose
  /// entire result is a system notification produces NOTHING on a Mac where
  /// notifications do not arrive, and the owner has no way to tell that from
  /// "it never found anything".
  ///
  /// So the offer goes to a panel this app draws itself, which is on screen
  /// because this code put it there, and the notification is a bonus for the
  /// Macs that deliver one.
  private func offer(_ url: URL, vintage: Date?, in directory: URL, key: String) {
    let dated: String
    if let vintage, !Calendar.current.isDateInToday(vintage) {
      let when = DateFormatter()
      when.dateStyle = .medium
      when.timeStyle = .none
      dated = when.string(from: vintage)
    } else {
      dated = "today"
    }
    let name = url.lastPathComponent
    let folder = directory.lastPathComponent
    // The key travels with it, because the answer is what spends the offer and
    // the answer comes back through the bridge.
    DispatchQueue.main.async { [weak self] in
      self?.bridge?.linkedInExportFound(
        at: url, name: name, folder: folder, dated: dated, key: key)
    }
    ModelSetup.notify(
      title: "found your LinkedIn export",
      body: "\(name) in \(folder), \(dated) — import it?",
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
      why = "there is no Connections.csv anywhere in that zip — tick \"connections\" when you request it."
    case "zip": why = "i couldn't open that zip."
    case "columns": why = "i don't recognise that file's columns — i can only read the english export."
    case "newer": why = "you already have a newer \(file) — i kept the one you have."
    case "duplicate": why = "there are two of those — open settings and choose one."
    default: why = "i couldn't read that file."
    }
    ModelSetup.notify(title: "couldn't import that", body: why)
  }
}
