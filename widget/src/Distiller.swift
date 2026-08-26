import Foundation
import AppKit

// THE STEP THAT MAKES THE CORPUS ANSWERABLE, and until now nothing ran it.
//
// The pipeline is: connectors read the sources into `context`, the DISTILLER asks
// the local model what the owner's own rows say and proposes claims, and answers
// come from accepted claims only — `retrieve.mjs` reads `v_claim_accepted` and
// nothing else. Miss the middle step and every question abstains on a full
// database. That is exactly what shipped: 11,237 context rows, 0 claims, and an
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

  /// Rows per pass. Small enough that a pass finishes in a visible amount of time
  /// on a local model, big enough that a long backlog still drains.
  private let batch = 40
  /// The same pass, sized for a machine that is running on its own battery.
  private let trickleBatch = 8
  /// Between passes while catching up, and while idle. Catching up is not urgent
  /// enough to saturate the machine the owner is using.
  private let busyInterval: TimeInterval = 45
  private let idleInterval: TimeInterval = 900
  /// How often to look again while paused. The power notifications below are the
  /// real wake-up; this is the backstop for one that never arrives.
  private let pausedInterval: TimeInterval = 300

  private var fm: FileManager { .default }
  private var home: URL { fm.homeDirectoryForCurrentUser }
  private var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }

  var isRunning: Bool { process?.isRunning == true }

  /// Begin supervising. Safe to call repeatedly.
  func start() {
    guard timer == nil, !stopping else { return }
    PowerBudget.startWatching()
    // Re-decide the moment conditions change rather than serving out an interval
    // chosen under the old ones: plugging in should start the backlog draining,
    // and the machine getting hot should stop it, without waiting up to fifteen
    // minutes to notice either.
    NotificationCenter.default.addObserver(
      forName: PowerBudget.didChange, object: nil, queue: .main
    ) { [weak self] _ in
      guard let self, !self.stopping, !self.isRunning else { return }
      self.schedule(after: PowerBudget.current == .paused ? self.pausedInterval : 1)
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
    // NOT WHILE THE MACHINE CANNOT AFFORD IT. Checked here rather than at
    // schedule() time because the answer can change during an interval, and the
    // decision that matters is the one taken the instant before the work starts.
    if PowerBudget.current == .paused {
      schedule(after: pausedInterval)
      return
    }
    let node = home.appendingPathComponent(".hazlie/bin/node")
    // TWO STEPS, IN ORDER. The episode index is derived from context, so it has
    // to be rebuilt before anything reads it -- otherwise a conversation that
    // arrived since the last pass is invisible to the distiller, and one that
    // grew is distilled at a stale shape.
    //
    // Episodes rather than rows, because the row was the wrong unit and this is
    // where that decision takes effect. A row reached the model alone -- "ok"
    // with no question above it -- and 99.4% of every call was the instruction
    // sheet. Measured on this corpus: 3,759 owner rows collapse into 1,030
    // conversations, so the same evidence costs a third of the calls and each
    // one carries the exchange it came from.
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
    // whole rebuild, so the two could stall each other for the full 5s
    // busy_timeout. And runOnce() is a main-run-loop timer callback, so waiting
    // on it froze the UI for the duration: the comment here used to say 110ms at
    // 12,782 rows; it measured 1,414ms at 113,371, and it grows with every
    // history slice that lands.
    //
    // Now it is one POST to the writer that already holds the lock, and the
    // distiller starts in the completion handler instead of after a blocked
    // main thread. A failure is still not fatal -- the distiller reads the
    // previous index, stale rather than wrong, and the next pass rebuilds it --
    // so this proceeds either way.
    rebuildIndex { [weak self] in
      guard let self, !self.stopping else { return }
      self.startDistiller(node: node, script: script)
    }
  }

  /// POST /admin/episodes/rebuild, then call `done` on the main queue whatever
  /// happened. Never throws the pass away: a rebuild that did not run leaves the
  /// previous index in place, which is stale rather than wrong.
  private func rebuildIndex(done: @escaping () -> Void) {
    let finish = { DispatchQueue.main.async(execute: done) }
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
    // On battery the pass is a fifth of the size: enough that the backlog still
    // moves and anything that just arrived gets distilled, small enough that it
    // is not what drains the charge.
    let size = PowerBudget.current == .trickle ? trickleBatch : batch
    p.arguments = [script.path, "--limit", String(size)]
    // OFF THE PERFORMANCE CORES. Without this the child inherits the app's
    // default QoS, so macOS schedules fifteen hours of inference on the same
    // cores as everything the owner is actually doing.
    //
    // .utility rather than .background deliberately: background adds aggressive
    // I/O throttling, and this pass holds a write lock on the corpus for its
    // duration -- making it slower there makes every reader wait longer, which
    // is the opposite of the intent.
    p.qualityOfService = .utility
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
        // A trickle pass waits the long interval whether or not there is more to
        // do -- that IS the trickle. Anything else comes back promptly while
        // there is a backlog, and slowly once there is not.
        let budget = PowerBudget.current
        let next: TimeInterval
        switch budget {
        case .paused: next = self.pausedInterval
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
