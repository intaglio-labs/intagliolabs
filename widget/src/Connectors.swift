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

  private var fm: FileManager { .default }
  private var home: URL { fm.homeDirectoryForCurrentUser }
  private var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }

  var isRunning: Bool { process?.isRunning == true }

  /// Start the daemon if it is not already up and its config exists. Safe to
  /// call repeatedly — onboarding calls it the moment it writes the config.
  func start() {
    guard !isRunning, !stopping else { return }
    let node = home.appendingPathComponent(".hazlie/bin/node")
    let script = backend.appendingPathComponent("connectors/daemon.mjs")
    let config = home.appendingPathComponent(".hazlie/connectors/config.json")
    guard fm.fileExists(atPath: node.path), fm.fileExists(atPath: script.path) else { return }
    // No config means the daemon would exit(1) immediately and we would respawn
    // it forever. Onboarding writes it and then calls start().
    guard fm.fileExists(atPath: config.path) else { return }

    let since = Date().timeIntervalSince(lastStart)
    if since < throttle {
      DispatchQueue.main.asyncAfter(deadline: .now() + (throttle - since)) { [weak self] in
        self?.start()
      }
      return
    }
    lastStart = Date()

    let p = Process()
    p.executableURL = node
    p.arguments = [script.path]
    // Same log files the agent wrote, so nothing that reads them has to change.
    let logs = home.appendingPathComponent(".hazlie/logs")
    try? fm.createDirectory(at: logs, withIntermediateDirectories: true,
                            attributes: [.posixPermissions: 0o700])
    for (name, set) in [("connectors.out.log", 1), ("connectors.err.log", 2)] {
      let url = logs.appendingPathComponent(name)
      if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
      guard let handle = try? FileHandle(forWritingTo: url) else { continue }
      handle.seekToEndOfFile()
      if set == 1 { p.standardOutput = handle } else { p.standardError = handle }
    }
    p.terminationHandler = { [weak self] _ in
      guard let self, !self.stopping else { return }
      self.process = nil
      // KeepAlive, moved here. Throttled by lastStart above.
      DispatchQueue.main.async { self.start() }
    }
    do {
      try p.run()
      process = p
      NSLog("Intaglio Labs: connectors running as a child of this app (pid \(p.processIdentifier))")
    } catch {
      NSLog("Intaglio Labs: could not start connectors: \(error.localizedDescription)")
    }
  }

  /// Called on quit. Terminate rather than leave an orphan holding cursors and
  /// a cache open — the daemon's own shutdown path closes them.
  func stop() {
    stopping = true
    process?.terminate()
    process = nil
  }
}
