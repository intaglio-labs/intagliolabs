import Foundation
import AppKit

// THE STEP THAT MAKES THE CORPUS ANSWERABLE, and until now nothing ran it.
//
// The pipeline is: connectors read the sources into `context`, the DISTILLER asks
// the local model what the owner's own rows say and proposes claims, and answers
// come from accepted claims only — `retrieve.mjs` reads `v_claim_accepted` and
// nothing else. Miss the middle step and every question abstains on a full
// database. That is exactly what shipped: context rows with no claims, and an
// owner asking why the app that "has full access" knows nothing.
//
// distill-once.mjs was written as a one-shot CLI and was never wired to anything —
// no launchd agent, no caller in the app. This is the caller.
//
// HOW IT WALKS HISTORY. Each completed run records through_changed_at, and the
// next run starts after it, so bounded passes march forward through the backlog
// without re-reading. So this runs SMALL BATCHES on a timer rather than one
// enormous backfill: a batch that ends is a batch whose progress is durable, the
// UI gets a number that moves, and quitting mid-catch-up costs one batch instead
// of the whole thing. When a pass returns no rows the backlog is clear and the
// cadence drops to an idle poll for whatever arrives next.
//
// A child of this app, like Connectors and for a weaker version of the same
// reason: it reads only our own database, but it must die with the app rather
// than outlive it holding a model and a cursor.
final class Distiller {
  static let shared = Distiller()
  private init() {}

  private var process: Process?
  private var timer: Timer?
  private var stopping = false
  private var rebuildingIndex = false

  /// Rows per pass. Small enough that a pass finishes in a visible amount of time
  /// on a local model, big enough that a long backlog still drains.
  private let batch = 40
  /// The same pass under Battery Saver. It still advances on battery and under
  /// thermal pressure; only the amount of work in one pass changes.
  private let trickleBatch = 8
  /// Between passes while catching up, and while idle. Catching up is not urgent
  /// enough to saturate the machine the owner is using.
  private let busyInterval: TimeInterval = 45
  private let idleInterval: TimeInterval = 900

  // OFF UNTIL THE OUTPUT HAS A DOOR. (Owner decision, 2026-08-27: "stop the
  // distiller from running until we have a way to surface this to the user.")
  //
  // The pass works and has produced claims on a private development install,
  // but NONE can answer a question because /vault/ask reads v_claim_accepted
  // and nothing has been accepted. Acceptance needs a human, by design.
  //
  // There are two places a human could do that and neither is in the app:
  //
  //   * the review queue at the connect page's /memory ("review what i have
  //     learned"), which works -- 198 claims a page with accept/reject on each
  //     -- but lives behind a tokenised link that expires daily, below the fold,
  //     and nothing in the widget, chat, people panel or connections page
  //     mentions or links to it;
  //   * one claim at a time in the chat, offered only when a question happens to
  //     abstain, via /admin/memory/suggest?limit=1.
  //
  // So a pass costs hours of local inference at the front of the queue of a
  // machine somebody is using, to grow a pile nobody is shown. Turn it back on
  // when the queue has an entrance from inside the product, not before.
  //
  // WHAT THIS DOES NOT STOP: the episode index rebuild below. That is arithmetic
  // rather than inference, it is cheap now that it writes only the difference,
  // and the topic chips on the people panel are counted per CONVERSATION from
  // it -- so leaving it off would quietly staleness the one part of this pipeline
  // the owner does see.
  private var distillationEnabled: Bool { fm.fileExists(atPath: enableMarker.path) }

  /// Create this file to run passes again, matching the connectors' marker idiom
  /// (`~/.hazlie/connectors/<name>.disabled`) with the polarity reversed: theirs
  /// records an owner's choice to stop something that works, this one records
  /// that the product is not ready for the output yet.
  private var enableMarker: URL { home.appendingPathComponent(".hazlie/distill.enabled") }

  private var fm: FileManager { .default }
  private var home: URL { fm.homeDirectoryForCurrentUser }
  private var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }

  var isRunning: Bool { process?.isRunning == true }

  /// Truth for Settings' live activity row. Episode indexing runs inside
  /// hermes, rather than as this class's child process, so it has its own state.
  var activity: String? {
    if isRunning { return "building local memory" }
    if rebuildingIndex { return "updating the conversation index" }
    return nil
  }

  /// Begin supervising. Safe to call repeatedly.
  func start() {
    guard timer == nil, !stopping else { return }
    PowerBudget.startWatching()
    // Re-decide the moment the owner changes performance mode rather than
    // serving out an interval chosen under the old setting.
    NotificationCenter.default.addObserver(
      forName: PowerBudget.didChange, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self, !self.stopping, !self.isRunning else { return }
      self.schedule(after: 1)
    }
    schedule(after: 20) // let hermes and llama-server settle first
  }

  func stop() {
    stopping = true
    timer?.invalidate()
    timer = nil
    process?.terminate()
    process = nil
  }

  private func schedule(after seconds: TimeInterval) {
    timer?.invalidate()
    guard !stopping else { return }
    let t = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in self?.runOnce() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func runOnce() {
    guard !isRunning, !stopping else { schedule(after: busyInterval); return }
    let node = home.appendingPathComponent(".hazlie/bin/node")
    // TWO STEPS, IN ORDER. The episode index is derived from context, so it has
    // to be rebuilt before anything reads it -- otherwise a conversation that
    // arrived since the last pass is invisible to the distiller, and one that
    // grew is distilled at a stale shape.
    //
    // Episodes rather than rows, because the row was the wrong unit and this is
    // where that decision takes effect. A row reached the model alone -- "ok"
    // with no question above it -- and 99.4% of every call was the instruction
    // sheet. A private development corpus confirmed that many owner rows
    // collapse into far fewer conversations, so the same evidence costs fewer
    // calls and each call carries the exchange it came from.
    let script = backend.appendingPathComponent("ui/scripts/distill-episodes.mjs")
    let db = home.appendingPathComponent(".hazlie/context/context.db")
    guard fm.fileExists(atPath: node.path), fm.fileExists(atPath: script.path),
          fm.fileExists(atPath: db.path) else {
      schedule(after: idleInterval)
      return
    }

    // ASK HERMES TO REBUILD THE INDEX; do not rebuild it here.
    //
    // This used to spawn `node ui/scripts/build-episodes.mjs` and
    // waitUntilExit() right on this line, which was wrong twice. It opened
    // context.db read-write from a SECOND process while hermes was serving and
    // ingesting against it, breaking the sole-writer rule that
    // connectors/AGENTS.md and ui/AGENTS.md both state -- and the corpus runs
    // journal_mode=DELETE, where a writer's lock excludes every reader for the
    // whole rebuild, so the two could stall each other for the busy timeout.
    // And runOnce() is a main-run-loop timer callback, so waiting on it froze
    // the UI for a duration that grows with every history slice that lands.
    //
    // Now it is one POST to the writer that already holds the lock, and the
    // distiller starts in the completion handler instead of after a blocked
    // main thread. A failure is still not fatal -- the distiller reads the
    // previous index, stale rather than wrong, and the next pass rebuilds it --
    // so this proceeds either way.
    rebuildIndex { [weak self] in
      guard let self, !self.stopping else { return }
      guard self.distillationEnabled else {
        self.announceDisabledOnce()
        // The long interval: with no passes running there is no backlog to
        // chase, and the index only needs to keep up with what arrives.
        self.schedule(after: self.idleInterval)
        return
      }
      self.startDistiller(node: node, script: script)
    }
  }

  private var saidDisabled = false

  /// Once per launch, not once per pass -- a log line every fifteen minutes
  /// saying nothing happened is how a log stops being read.
  private func announceDisabledOnce() {
    guard !saidDisabled else { return }
    saidDisabled = true
    NSLog(
      "Intaglio Labs: distillation is off (no in-app way to review claims yet); "
        + "episode index still rebuilding. Create \(enableMarker.path) to re-enable."
    )
  }

  /// POST /admin/episodes/rebuild, then call `done` on the main queue whatever
  /// happened. Never throws the pass away: a rebuild that did not run leaves the
  /// previous index in place, which is stale rather than wrong.
  private func rebuildIndex(done: @escaping () -> Void) {
    rebuildingIndex = true
    let finish = { [weak self] in
      DispatchQueue.main.async {
        self?.rebuildingIndex = false
        done()
      }
    }
    guard let tok = hermesToken(),
          let url = URL(string: "http://127.0.0.1:51789/admin/episodes/rebuild") else {
      finish()
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    // Generous: a full rebuild is seconds on a large corpus and this is a
    // background pass with nothing waiting on it.
    req.timeoutInterval = 120
    URLSession.shared.dataTask(with: req) { _, response, error in
      if let error {
        NSLog("Intaglio Labs: episode index rebuild failed: \(error.localizedDescription)")
      } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
        NSLog("Intaglio Labs: episode index rebuild refused (status \(http.statusCode))")
      }
      finish()
    }.resume()
  }

  /// The hermes bearer, read the same way Bridge reads it. Sixty-four hex
  /// characters or nothing -- a malformed token is treated as no token, so a
  /// half-written secrets file cannot become an Authorization header.
  private func hermesToken() -> String? {
    let url = home.appendingPathComponent(".hazlie/secrets/hermes-token.txt")
    guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    let tok = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let hex = Set("0123456789abcdef")
    guard tok.count == 64, tok.allSatisfy({ hex.contains($0) }) else { return nil }
    return tok
  }

  private func startDistiller(node: URL, script: URL) {
    let p = Process()
    p.executableURL = node
    // --backfill with a wide window and a row cap: the window says "all of
    // history is in scope", the cap says "not all of it at once", and the
    // watermark makes the next pass continue instead of repeat.
    // Battery Saver makes the pass a fifth of the size: enough that the backlog
    // still moves, small enough to reduce sustained load.
    let size = PowerBudget.current == .trickle ? trickleBatch : batch
    p.arguments = [script.path, "--limit", String(size)]
    // God Mode asks macOS for foreground-class scheduling; Battery Saver keeps
    // the same work at utility QoS. Neither choice depends on charger or heat.
    p.qualityOfService = PowerBudget.current == .full ? .userInitiated : .utility
    // The script resolves prompts/ relative to the backend root, so it has to run
    // from ui/ exactly as its own usage block says.
    p.currentDirectoryURL = backend.appendingPathComponent("ui")

    // stdout is the run's JSON summary and is the only thing worth keeping; the
    // script is built never to log source text, so these files carry counts, ids
    // and reasons only.
    let logs = home.appendingPathComponent(".hazlie/logs")
    try? fm.createDirectory(at: logs, withIntermediateDirectories: true,
                            attributes: [.posixPermissions: 0o700])
    let out = Pipe()
    p.standardOutput = out
    if let errURL = try? logFile(logs.appendingPathComponent("distill.err.log")) {
      p.standardError = errURL
    }

    p.terminationHandler = { [weak self] proc in
      guard let self else { return }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      self.process = nil
      // rows_in == 0 means the backlog is drained: poll slowly for new arrivals.
      // Anything else means there is more to do, so come back promptly.
      var rowsIn = -1
      if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let n = json["episodes_in"] as? Int {
        rowsIn = n
      }
      let drained = (rowsIn == 0)
      if proc.terminationStatus != 0 {
        NSLog("Intaglio Labs: distill pass failed (status \(proc.terminationStatus))")
      } else if rowsIn > 0 {
        NSLog("Intaglio Labs: distilled \(rowsIn) conversations")
      }
      DispatchQueue.main.async {
        // A Battery Saver pass waits the long interval whether or not there is
        // more to do. God Mode comes back promptly while there is a backlog.
        let budget = PowerBudget.current
        let next: TimeInterval
        switch budget {
        case .trickle: next = self.idleInterval
        case .full: next = drained ? self.idleInterval : self.busyInterval
        }
        self.schedule(after: next)
      }
    }

    do {
      try p.run()
      process = p
    } catch {
      NSLog("Intaglio Labs: could not start the distiller: \(error.localizedDescription)")
      schedule(after: idleInterval)
    }
  }

  private func logFile(_ url: URL) throws -> FileHandle {
    if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
    let h = try FileHandle(forWritingTo: url)
    h.seekToEndOfFile()
    return h
  }
}
