// DOES THE INSTALLED `claude` CLIENT ACTUALLY WORK, ASKED FROM THE APP.
//
// Onboarding's "how it reads" screen offers one optional switch: use the
// owner's own Claude subscription to build person pages instead of the local
// model. That switch sends message excerpts off this Mac, so the screen must
// not offer it on a guess. "The binary resolves" is a guess — a client can be
// installed and logged out, installed and rate-limited, or too old for the way
// hermes calls it, and each of those looks identical to a resolvability check
// while producing a page builder that fails on every run.
//
// So this runs the client, once, with an eight-byte prompt, and reports what
// came back.
//
// THE ARGUMENTS AND THE ENVIRONMENT ARE COPIED FROM ui/server/relationship/
// engines.mjs, NOT from FrontierRunner.swift, and the difference is not
// cosmetic. engines.mjs is the code that will actually build pages if this
// switch goes on, and it differs from the frontier handoff's invocation in two
// ways that each flip the answer:
//
//   --safe-mode   FrontierRunner passes it; claudeArgs() does not. A probe
//                 that passes a flag the real caller omits is answering about
//                 a different invocation.
//   USER/LOGNAME  engines.mjs passes exactly PATH, HOME, USER, LOGNAME,
//                 TMPDIR, and its own comment records that dropping USER and
//                 LOGNAME makes the client's keychain lookup fail and answer
//                 "Not logged in" (measured 2026-09-07 under hermes' launchd
//                 environment). A probe with a richer environment returns ok
//                 for a configuration hermes will fail on.
//
// widget/test/engine-probe.test.mjs compares the two argument lists token for
// token and fails if they drift. When you change one, change the other.
//
// THE RESIDUAL, ACCEPTED (design P4): the probe runs in the APP's environment
// and the real calls run in hermes' launchd environment. If hermes' PATH omits
// ~/.local/bin and the app's does not, this says ok and hermes says missing.
// Screen 6 shows which engine actually built the first page, so the lie is
// visible within one screen; a second probe from inside hermes is not worth
// the wiring at this stage.
//
// NO SHELL, EVER. Process with an explicit executableURL and an explicit
// argument array — nothing here is a command line a string could be smuggled
// into.
import Foundation

enum EngineProbe {
  /// The smallest question that still requires the whole pipeline to work:
  /// auth, model access and envelope formatting. Deliberately not a word the
  /// classifier below scans for.
  static let systemPrompt = "Reply with the single word: ready"
  /// engines.mjs defaults relationshipMemory.engineModel to 'sonnet'; the
  /// probe must ask the same model, because plan access differs by model and
  /// "your plan is rate-limited" is one of the answers this screen renders.
  static let model = "sonnet"
  private static let stdinPrompt = "ready?"
  /// 20s. The real page builder's ceiling is 120s (CLAUDE_TIMEOUT_MS), but
  /// this is a setup screen with somebody watching it: a client that has not
  /// answered a two-token prompt in twenty seconds is a client the owner
  /// should be told about, not one to keep waiting on.
  private static let timeoutSeconds = 20

  private static let queue = DispatchQueue(label: "io.intaglio.engine-probe")
  private static var running = false

  /// The engine the owner's config currently selects, read back from disk.
  ///
  /// The toggle on screen 5 renders FROM THIS, not from a constant. A replay
  /// of onboarding on a machine where the owner already opted in would
  /// otherwise draw the switch off — a silent implied opt-out nobody made,
  /// one tap away from being written back as the real answer (design P12).
  /// Absent key means llama, which is engines.mjs's stated contract.
  static func configuredEngine() -> String {
    let path = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/connectors/config.json")
    guard let data = try? Data(contentsOf: path),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let memory = root["relationshipMemory"] as? [String: Any],
          let engine = memory["engine"] as? String
    else { return "local" }
    return engine
  }

  /// Run the probe. The completion carries `state` plus, when a binary was
  /// found, the resolved `binary` path, and always the currently configured
  /// engine so the page can render the toggle from the file rather than from
  /// an assumption.
  static func run(_ done: @escaping ([String: Any]) -> Void) {
    let finish: ([String: Any]) -> Void = { result in
      var out = result
      out["engine"] = configuredEngine()
      DispatchQueue.main.async { done(out) }
    }
    queue.async {
      guard !running else {
        finish(["state": "busy"])
        return
      }
      guard let binary = executable(named: "claude") else {
        finish(["state": "missing"])
        return
      }
      running = true
      let job = ProbeJob(binary: binary) { result in
        queue.async { running = false }
        var out = result
        out["binary"] = binary.path
        finish(out)
      }
      job.start()
    }
  }

  /// One spawn, parsed at pipe EOF.
  ///
  /// PARSE AT EOF, NOT AT PROCESS EXIT — the same rule, and the same reason,
  /// as ClaudeFrontierJob: an empty availableData is EOF and its hop onto this
  /// serial queue is enqueued behind every data hop, so once both closed flags
  /// are set the buffers hold the whole stream. The termination callback has
  /// no such ordering against the pipe's last chunk, and parsing there reads a
  /// truncated tail (reviewed 2026-08-31).
  private final class ProbeJob {
    private let binary: URL
    private let finish: ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "io.intaglio.engine-probe.job")
    private var process: Process?
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?
    private var stdout = Data()
    private var stderr = Data()
    private var stdoutClosed = false
    private var stderrClosed = false
    private var exitStatus: Int32?
    private var settled = false
    private var timer: DispatchSourceTimer?
    private let outputLimit = 1_000_000

    init(binary: URL, finish: @escaping ([String: Any]) -> Void) {
      self.binary = binary
      self.finish = finish
    }

    func start() {
      queue.async { [self] in
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        process.executableURL = binary
        process.environment = EngineProbe.environment()
        // BYTE-FOR-BYTE claudeArgs() from ui/server/relationship/engines.mjs.
        // See the file header: no --safe-mode, and the order is the order
        // there so the comparison test can read both as token lists.
        process.arguments = [
          "-p",
          "--output-format", "json",
          "--tools", "",
          "--permission-mode", "dontAsk",
          "--strict-mcp-config",
          "--mcp-config", "{\"mcpServers\":{}}",
          "--settings", "{}",
          "--setting-sources", "",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--no-chrome",
          "--prompt-suggestions", "false",
          "--system-prompt", EngineProbe.systemPrompt,
          "--model", EngineProbe.model,
        ]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        self.process = process
        self.stdoutHandle = output.fileHandleForReading
        self.stderrHandle = errors.fileHandleForReading

        self.stdoutHandle?.readabilityHandler = { [weak self] handle in
          let data = handle.availableData
          if data.isEmpty {
            handle.readabilityHandler = nil
            self?.queue.async { self?.stdoutClosed = true; self?.maybeFinish() }
            return
          }
          self?.queue.async {
            guard let self, self.stdout.count < self.outputLimit else { return }
            self.stdout.append(data.prefix(self.outputLimit - self.stdout.count))
          }
        }
        self.stderrHandle?.readabilityHandler = { [weak self] handle in
          let data = handle.availableData
          if data.isEmpty {
            handle.readabilityHandler = nil
            self?.queue.async { self?.stderrClosed = true; self?.maybeFinish() }
            return
          }
          self?.queue.async {
            guard let self, self.stderr.count < self.outputLimit else { return }
            self.stderr.append(data.prefix(self.outputLimit - self.stderr.count))
          }
        }
        process.terminationHandler = { [weak self] proc in
          self?.queue.async {
            self?.exitStatus = proc.terminationStatus
            self?.maybeFinish()
          }
        }
        do {
          try process.run()
          try input.fileHandleForWriting.write(contentsOf: Data(EngineProbe.stdinPrompt.utf8))
          try input.fileHandleForWriting.close()
        } catch {
          // A spawn failure is not "the client refused"; it is "there was no
          // client to refuse". Reported as error rather than auth so the
          // screen does not send the owner to a login that would not help.
          self.settle(["state": "error"])
          return
        }
        self.startTimer()
      }
    }

    private func maybeFinish() {
      guard !settled, let status = exitStatus, stdoutClosed, stderrClosed else { return }
      let err = String(data: stderr, encoding: .utf8) ?? ""
      let envelope = (try? JSONSerialization.jsonObject(with: stdout)) as? [String: Any]
      if status == 0, let envelope,
         envelope["is_error"] as? Bool != true,
         envelope["result"] is String {
        settle(["state": "ok"])
        return
      }
      // Classify from the envelope's own error fields and stderr, never from a
      // successful answer body — the same split ClaudeFrontierJob keeps, for
      // the same reason: failure words inside a model's ANSWER are not the
      // provider failing.
      let structured = envelope?["is_error"] as? Bool == true
        ? (envelope?["result"] as? String ?? "") : ""
      let prose = envelope == nil ? (String(data: stdout, encoding: .utf8) ?? "") : ""
      settle(providerFailure([structured, prose, err].joined(separator: "\n")))
    }

    private func startTimer() {
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + .seconds(EngineProbe.timeoutSeconds))
      timer.setEventHandler { [weak self] in
        guard let self else { return }
        // SIGKILL, not terminate(). This child is a one-shot probe with no
        // state to flush and nothing to clean up, and a client that is wedged
        // hard enough to ignore a two-token prompt for twenty seconds is one
        // that can ignore a TERM as well — which would leave the screen
        // waiting on a process nobody is watching any more.
        if let pid = self.process?.processIdentifier, self.process?.isRunning == true {
          kill(pid, SIGKILL)
        }
        self.settle(["state": "slow"])
      }
      self.timer = timer
      timer.resume()
    }

    private func settle(_ result: [String: Any]) {
      guard !settled else { return }
      settled = true
      timer?.cancel()
      timer = nil
      stdoutHandle?.readabilityHandler = nil
      stderrHandle?.readabilityHandler = nil
      try? stdoutHandle?.close()
      try? stderrHandle?.close()
      stdoutHandle = nil
      stderrHandle = nil
      let proc = process
      process = nil
      if let proc, proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
      finish(result)
    }
  }

  /// Exactly the five variables engines.mjs passes, and nothing else. See the
  /// file header for why USER and LOGNAME are load-bearing rather than
  /// decoration.
  private static func environment() -> [String: String] {
    let source = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let user = NSUserName()
    return [
      "PATH": source["PATH"] ?? "",
      "HOME": source["HOME"] ?? home,
      "USER": source["USER"] ?? user,
      "LOGNAME": source["LOGNAME"] ?? source["USER"] ?? user,
      "TMPDIR": source["TMPDIR"] ?? NSTemporaryDirectory(),
    ]
  }
}
