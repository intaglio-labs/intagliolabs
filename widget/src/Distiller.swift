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
  /// Between passes while catching up, and while idle. Catching up is not urgent
  /// enough to saturate the machine the owner is using.
  private let busyInterval: TimeInterval = 45
  private let idleInterval: TimeInterval = 900

  private var fm: FileManager { .default }
  private var home: URL { fm.homeDirectoryForCurrentUser }
  private var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }

  var isRunning: Bool { process?.isRunning == true }

  /// Begin supervising. Safe to call repeatedly.
  func start() {
    guard timer == nil, !stopping else { return }
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
    let script = backend.appendingPathComponent("ui/scripts/distill-once.mjs")
    let db = home.appendingPathComponent(".hazlie/context/context.db")
    guard fm.fileExists(atPath: node.path), fm.fileExists(atPath: script.path),
          fm.fileExists(atPath: db.path) else {
      schedule(after: idleInterval)
      return
    }

    let p = Process()
    p.executableURL = node
    // --backfill with a wide window and a row cap: the window says "all of
    // history is in scope", the cap says "not all of it at once", and the
    // watermark makes the next pass continue instead of repeat.
    p.arguments = [script.path, "--backfill", "--from-days", "3650",
                   "--limit", String(batch)]
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
         let n = json["rows_in"] as? Int {
        rowsIn = n
      }
      let drained = (rowsIn == 0)
      if proc.terminationStatus != 0 {
        NSLog("Intaglio Labs: distill pass failed (status \(proc.terminationStatus))")
      } else if rowsIn > 0 {
        NSLog("Intaglio Labs: distilled \(rowsIn) rows")
      }
      DispatchQueue.main.async {
        self.schedule(after: drained ? self.idleInterval : self.busyInterval)
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
