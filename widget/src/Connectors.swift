// The connectors daemon, run as a CHILD OF THIS APP rather than by launchd.
//
// WHY, AND IT IS THE WHOLE POINT: macOS attributes a TCC grant to the
// RESPONSIBLE process, and a process spawned by another inherits responsibility
// from its parent. Under launchd, node is spawned by launchd and is therefore
// responsible for itself — so Full Disk Access had to be granted to
// ~/.hazlie/bin/node, and the owner was asked to find a unix binary in a file
// picker and hand it the keys to their whole disk. The System Settings row said
// "node". Nobody installed node.
//
// Spawned from here, the responsible process is Intaglio Labs.app. One row, in
// the app's own name, with the app's own icon — and the same inheritance covers
// the Contacts, Calendar and Photos grants this app requests through the normal
// APIs, so those become one-click system prompts instead of a second trip to
// Settings. See Permissions.swift.
//
// WHAT IT COSTS. The daemon now lives and dies with the app: no KeepAlive from
// launchd, no polling while the widget is quit. For a desktop widget that is
// meant to sit there all day that is close to free, and it buys a permission
// model a person can actually understand. Supervision moves here — restart on
// exit, throttled, and killed cleanly on quit so no orphan keeps a database
// handle open.
import Foundation
import AppKit

final class Connectors {
  static let shared = Connectors()
  private init() {}

  private var process: Process?
  private var stopping = false
  private var lastStart = Date.distantPast
  /// Matches the ThrottleInterval the launchd agent used to carry, for the same
  /// reason: a daemon that fails instantly should not be respawned in a tight
  /// loop, and its failure is usually a missing config the owner has to fix.
  private let throttle: TimeInterval = 60
  /// A bundle install restarts Hermes and then opens the app. Hermes needs a few
  /// seconds to warm its people index, so its first health check can race the
  /// connector child. These bounded retries cover that one startup window;
  /// persistent failures still fall back to the normal 60-second throttle.
  private let warmupRetryDelays: [TimeInterval] = [4, 8, 16]
  private var warmupRetries = 0

  private var fm: FileManager { .default }
  private var home: URL { fm.homeDirectoryForCurrentUser }
  private var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }
  private var activityFile: URL { home.appendingPathComponent(".hazlie/connectors/activity.json") }

  private var activitySnapshot: [String: Any]? {
    guard let data = try? Data(contentsOf: activityFile),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return raw
  }

  private func scheduledActivityTasks(_ raw: [String: Any]) -> [(connector: String, label: String?, nextTs: Double)] {
    (raw["queue"] as? [[String: Any]] ?? [])
      .compactMap { row -> (connector: String, label: String?, nextTs: Double)? in
        guard let connector = row["connector"] as? String,
              let nextTs = row["nextTs"] as? Double else { return nil }
        return (connector, row["label"] as? String, nextTs)
      }
      .sorted { $0.nextTs < $1.nextTs }
  }

  /// A scheduled start is useful context, but it is never an estimate of how
  /// long a connector will take. Keeping those two facts separate prevents an
  /// idle queue from looking like a stalled processing job.
  private func scheduledDelayLabel(_ nextTs: Double, now: Double) -> String {
    let deltaMs = nextTs - now
    if deltaMs < -90_000 { return "overdue" }
    if deltaMs <= 0 { return "due now" }
    let minutes = Int(ceil(deltaMs / 60_000))
    if minutes == 1 { return "in 1 min" }
    if minutes < 60 { return "in \(minutes) min" }
    let hours = minutes / 60
    let remainder = minutes % 60
    if remainder == 0 { return "in \(hours)h" }
    return "in \(hours)h \(remainder)m"
  }

  /// Matrix is one local transport for several user-facing connectors. The
  /// daemon expands it into one queued task per connected platform; preserve
  /// those names anywhere Settings describes Matrix work instead of leaking
  /// the implementation-shaped "social messages" label back into the UI.
  private func matrixPlatformLabels(_ raw: [String: Any]) -> [String] {
    var seen = Set<String>()
    return scheduledActivityTasks(raw).compactMap { task in
      guard task.connector == "matrix",
            let label = task.label?.trimmingCharacters(in: .whitespacesAndNewlines),
            !label.isEmpty,
            seen.insert(label).inserted else { return nil }
      return label
    }
  }

  /// The daemon's current pass plus its actual scheduled queue. This is read
  /// from a private local snapshot, never inferred from a connector merely
  /// being installed or enabled.
  var activityItems: [[String: Any]] {
    guard let raw = activitySnapshot else { return [] }
    let names = ["imessage": "iMessage", "matrix": "connected platforms", "maintenance": "maintenance"]
    let labelFor = { (connector: String) in names[connector] ?? String(connector.prefix(32)) }
    let now = Date().timeIntervalSince1970 * 1000
    var items: [[String: Any]] = []
    let portalInvitesPending = raw["portalInvitesPending"] as? Int ?? 0
    if raw["phase"] as? String == "syncing",
       let connector = raw["connector"] as? String,
       let started = raw["startedTs"] as? Double,
       now - started < 90_000 {
      let platforms = raw["platforms"] as? [String] ?? []
      let label = connector == "matrix" && !platforms.isEmpty
        ? platforms.joined(separator: " · ")
        : labelFor(connector)
      items.append(["kind": "current", "label": "current: syncing \(label)"])
    }

    if portalInvitesPending > 0 {
      items.append([
        "kind": "discovery",
        "label": "joining \(portalInvitesPending) conversation\(portalInvitesPending == 1 ? "" : "s")",
      ])
    }

    // Historical catch-up remains a named job in the list. Its duration is not
    // repeated here: the pinned header is the horizon for the ENTIRE queue.
    if let backfill = raw["backfill"] as? [String], !backfill.isEmpty {
      let year = raw["backfillYear"] as? Int
      for connector in backfill {
        // Matrix history is deliberately paused until every existing portal
        // invitation is joined. Showing a year here would claim the backwards
        // walk is active while the app is still discovering its room roster.
        if connector == "matrix" && portalInvitesPending > 0 { continue }
        let subjects = connector == "matrix" ? matrixPlatformLabels(raw) : [labelFor(connector)]
        // SAY HOW MANY, since we cannot honestly say how long. The daemon
        // used to publish an ETA for this and it could not move: the
        // arithmetic was ceil(rooms / perPass), which with 9 rooms and a rate
        // of 11 is always 1, so the header read "~ 0.2 hrs left" on every
        // pass while the per-room pagination cursors ran thousands of events
        // deep. A count of conversations is a count of real objects, and it
        // changes.
        let rooms = raw["backfillRooms"] as? Int ?? 0
        let scope = connector == "matrix" && rooms > 0
          ? " (\(rooms) conversation\(rooms == 1 ? "" : "s"))"
          : ""
        for subject in subjects.isEmpty ? [labelFor(connector)] : subjects {
          items.append([
            "kind": "backfill",
            // WHICH YEAR and HOW MANY CONVERSATIONS answer different halves of
            // the same question, so the row carries both. The year comes from
            // the cross-connector barrier; the count replaced an ETA that could
            // not move (see daemon.mjs totalWorkEstimate).
            "label": year.map { "fetching \($0) \(subject)\(scope)" }
              ?? "backfilling \(subject) history\(scope)",
          ])
        }
      }
    }

    let queue = scheduledActivityTasks(raw)
    for task in queue {
      // A scheduled time is when work STARTS, not work happening now and not a
      // duration. The one countdown belongs in the Activity header; repeating
      // it on every row made a single schedule look like many stalled jobs.
      let label = task.label ?? labelFor(task.connector)
      items.append([
        "kind": "queue",
        "label": "next: \(label)",
      ])
    }

    // Bundles built before the queue schema retain a useful one-line NEXT row.
    // It must not be called current: nextTs is a start time in those snapshots.
    if queue.isEmpty,
       raw["phase"] as? String == "waiting",
       let connector = raw["connector"] as? String {
      let label = raw["label"] as? String ?? labelFor(connector)
      items.append(["kind": "queue", "label": "next: \(label)"])
    }
    return items
  }

  /// Approximate wall-clock horizon for every task currently represented by
  /// the daemon queue. Kept separate from activityItems so the UI can pin it in
  /// the card header instead of letting a long task label clip it away.
  /// How many conversations the current backfill is walking, when the daemon
  /// knows. This is what replaced the estimate for matrix history: a count of
  /// real objects that changes, rather than ceil(rooms / perPass), which was
  /// always 1 and so always read as one interval away.
  var activityBackfillRooms: Int? {
    guard let raw = activitySnapshot else { return nil }
    let n = (raw["portalInvitesPending"] as? Int).flatMap { $0 > 0 ? $0 : nil }
      ?? (raw["backfillRooms"] as? Int).flatMap { $0 > 0 ? $0 : nil }
    guard let n else {
      return nil
    }
    return n
  }

  var activityEstimate: String? {
    guard let raw = activitySnapshot else { return nil }
    return normalizedActivityEstimate(raw)
  }

  /// The next recurring connector run, rendered once in Activity's header.
  /// This is deliberately not called "time left": routine polling never
  /// finishes, while a genuine finite backfill has activityEstimate above.
  var activityScheduleEstimate: String? {
    guard let raw = activitySnapshot else { return nil }
    // A retry countdown is not a completion estimate. During portal discovery
    // the finite remaining count above is both more useful and actually true.
    if let n = raw["portalInvitesPending"] as? Int, n > 0 { return nil }
    let now = Date().timeIntervalSince1970 * 1000
    guard let next = scheduledActivityTasks(raw)
      .filter({ $0.connector != "maintenance" })
      .first else { return nil }
    return "next run \(scheduledDelayLabel(next.nextTs, now: now))"
  }

  /// Keeps the ambient processing state continuous between bounded connector
  /// passes. The daemon intentionally publishes `waiting` after one source
  /// finishes and before the next scheduled source starts; that is a pause in
  /// one queue, not completion of the multi-hour job Settings is displaying.
  /// Requiring both a non-empty queue and its total estimate prevents a stale
  /// or malformed activity file from waking the orb on its own.
  var queuedWorkLabel: String? {
    guard let raw = activitySnapshot, !scheduledActivityTasks(raw).isEmpty else { return nil }
    if let n = raw["portalInvitesPending"] as? Int, n > 0 {
      return "joining social conversations"
    }
    guard normalizedActivityEstimate(raw) != nil else { return nil }
    return "working through connector queue"
  }

  /// The one connector operation happening now, if any. Unlike activityItems,
  /// this deliberately excludes the routine scheduled queue. Unfinished
  /// historical backfill is different: the short rests between its bounded
  /// slices are part of one multi-hour job, so the orb stays in its processing
  /// pose until that job reaches the beginning of the source.
  var activeWorkLabel: String? {
    guard let raw = activitySnapshot else { return nil }
    let names = ["imessage": "iMessage", "matrix": "connected platforms"]
    let labelFor = { (connector: String) in names[connector] ?? String(connector.prefix(32)) }
    if raw["phase"] as? String == "syncing",
       let connector = raw["connector"] as? String,
       let started = raw["startedTs"] as? Double,
       Date().timeIntervalSince1970 * 1000 - started < 90_000 {
      let platforms = raw["platforms"] as? [String] ?? []
      if connector == "matrix", !platforms.isEmpty {
        return "syncing \(platforms.joined(separator: " · "))"
      }
      return "syncing \(labelFor(connector))"
    }
    if raw["phase"] as? String == "waiting",
       let n = raw["portalInvitesPending"] as? Int, n > 0 {
      return "joining social conversations"
    }
    if raw["phase"] as? String == "waiting",
       let estimate = raw["estimate"] as? String,
       !estimate.isEmpty,
       let connector = (raw["backfill"] as? [String])?.first {
      let year = raw["backfillYear"] as? Int
      if connector == "matrix", let platform = matrixPlatformLabels(raw).first {
        return year.map { "fetching \($0) \(platform)" } ?? "backfilling \(platform)"
      }
      return year.map { "fetching \($0) \(labelFor(connector))" }
        ?? "backfilling \(labelFor(connector))"
    }
    return nil
  }

  private func normalizedActivityEstimate(_ raw: [String: Any]) -> String? {
    guard let estimate = raw["estimate"] as? String, !estimate.isEmpty else { return nil }
    // Snapshots written just before the label cleanup can survive one app
    // restart. Normalize them here so the backfill row never flashes ≥/≈.
    if estimate.hasPrefix("≥ ") || estimate.hasPrefix("≈ ") {
      return "~ " + String(estimate.dropFirst(2))
    }
    return estimate
  }

  var isRunning: Bool { process?.isRunning == true }

  /// Start the daemon if it is not already up and its config exists. Safe to
  /// call repeatedly — onboarding calls it the moment it writes the config.
  func start(bypassingThrottle: Bool = false) {
    guard !isRunning, !stopping else { return }
    let node = home.appendingPathComponent(".hazlie/bin/node")
    let script = backend.appendingPathComponent("connectors/daemon.mjs")
    let config = home.appendingPathComponent(".hazlie/connectors/config.json")
    guard fm.fileExists(atPath: node.path), fm.fileExists(atPath: script.path) else { return }
    // No config means the daemon would exit(1) immediately and we would respawn
    // it forever. Onboarding writes it and then calls start().
    guard fm.fileExists(atPath: config.path) else { return }

    let since = Date().timeIntervalSince(lastStart)
    if !bypassingThrottle && since < throttle {
      DispatchQueue.main.asyncAfter(deadline: .now() + (throttle - since)) { [weak self] in
        self?.start()
      }
      return
    }
    lastStart = Date()

    let p = Process()
    p.executableURL = node
    // Same reasoning as the distiller: a scheduled ingest is background work and
    // has no business competing for performance cores with what the owner is
    // doing. Not paused on battery -- an ingest is short and keeping the corpus
    // current is the point of the app -- just scheduled politely.
    p.qualityOfService = .utility
    p.arguments = [script.path]
    var environment = ProcessInfo.processInfo.environment
    environment["INTAGLIO_CONNECTOR_OWNER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
    p.environment = environment
    // Same log files the agent wrote, so nothing that reads them has to change.
    let logs = home.appendingPathComponent(".hazlie/logs")
    try? fm.createDirectory(at: logs, withIntermediateDirectories: true,
                            attributes: [.posixPermissions: 0o700])
    try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: logs.path)
    for (name, set) in [("connectors.out.log", 1), ("connectors.err.log", 2)] {
      let url = logs.appendingPathComponent(name)
      if !fm.fileExists(atPath: url.path) {
        fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
      }
      // Connector errors may reveal which private local service is configured.
      // Existing installs predate the owner-only mode, so harden both new and
      // already-present files before handing them to the child process.
      try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      guard let handle = try? FileHandle(forWritingTo: url) else { continue }
      handle.seekToEndOfFile()
      if set == 1 { p.standardOutput = handle } else { p.standardError = handle }
    }
    let startedAt = Date()
    p.terminationHandler = { [weak self, weak p] _ in
      let ranFor = Date().timeIntervalSince(startedAt)
      DispatchQueue.main.async {
        guard let self, let p, !self.stopping, self.process === p else { return }
        self.process = nil
        // The only fast restart is the bounded Hermes warm-up window. It makes
        // a just-installed widget self-healing without turning a bad config or
        // a permanent preflight failure into a tight respawn loop.
        if ranFor < 30, self.warmupRetries < self.warmupRetryDelays.count {
          let delay = self.warmupRetryDelays[self.warmupRetries]
          self.warmupRetries += 1
          DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.start(bypassingThrottle: true)
          }
        } else {
          self.warmupRetries = 0
          // KeepAlive, moved here. Throttled by lastStart above.
          self.start()
        }
      }
    }
    do {
      try p.run()
      process = p
      NSLog("Intaglio Labs: connectors running as a child of this app (pid \(p.processIdentifier))")
    } catch {
      NSLog("Intaglio Labs: could not start connectors: \(error.localizedDescription)")
    }
  }

  /// Respawn the daemon so it picks up a permission granted since it started.
  ///
  /// Full Disk Access attaches to the RESPONSIBLE process — this app — but the
  /// child evaluates it when it opens a file, and its startup preflight ran once
  /// at spawn. So a daemon that started before the switch moved is carrying a
  /// denial it has no reason to re-examine.
  ///
  /// Terminating IS the restart: the termination handler above respawns, and
  /// throttles. Deliberately NOT stop() — that sets `stopping` for the process
  /// lifetime, because it exists for quitting, and calling it here would retire
  /// the daemon until the app was relaunched. Which is the very restart this
  /// exists to make unnecessary.
  func restart() {
    guard !stopping else { return }
    guard let p = process, p.isRunning else {
      start() // not up: nothing to replace, and start() is idempotent
      return
    }
    NSLog("Intaglio Labs: respawning connectors to pick up a new grant")
    p.terminate()
  }

  /// Called on quit. Terminate rather than leave an orphan holding cursors and
  /// a cache open — the daemon's own shutdown path closes them.
  func stop() {
    stopping = true
    process?.terminate()
    process = nil
  }
}
