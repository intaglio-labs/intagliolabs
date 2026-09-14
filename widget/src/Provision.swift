import Foundation

// First-run provisioning for a DOWNLOADED app: stand up the local backend
// (hermes, connect, connectors) from the code and node bundled inside the app,
// with no repo, no Homebrew, and no network. See widget/build.sh for what the
// bundle carries.
//
// SAFE BY DEFAULT. Once the connect agent exists in ~/Library/LaunchAgents —
// true on the owner's repo-based setup and after any prior provision — the
// whole copy-and-bootstrap path is skipped, so it never clobbers a working
// machine. ~~The one thing every launch still ensures is the secret files~~ —
// there are three, and each is there because "the plist exists" turned out to
// answer a narrower question than the skip assumed:
//
//   ensureSecrets — generation is per-file and only-if-missing, so installs
//   provisioned by a build that predates llama-api-key.txt gain the key on
//   upgrade instead of crash-looping forever.
//
//   repairLlamaAgent — a plist that provisioning legitimately skipped, for
//   weights that arrived later.
//
//   bootstrapUnloadedAgents — a plist that is here while launchd has no job for
//   it. Booting the agents out by hand and leaving their plists survived a quit
//   and a relaunch (2026-09-14), because every install path bootstraps only at
//   the moment it WRITES a plist.
//
// All three are only-if-missing in their own way, so a healthy machine sees a
// no-op.
enum Provision {
  private static let fm = FileManager.default
  private static var home: URL { fm.homeDirectoryForCurrentUser }
  private static var hazlie: URL { home.appendingPathComponent(".hazlie") }
  private static var launchAgents: URL { home.appendingPathComponent("Library/LaunchAgents") }
  // The repo-shaped backend tree inside the app bundle. @REPO@ resolves here.
  private static var backend: URL {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("backend")
  }

  // Bootstrapped in this order: hermes migrates and opens its DB first, then
  // connect, then connectors last so their first /ingest hits a ready server.
  // CONNECTORS IS NOT HERE ANY MORE, and its absence is the point.
  //
  // It runs as a child of this app instead (Connectors.swift), because macOS
  // attributes a TCC grant to the RESPONSIBLE process: spawned by launchd, node
  // was responsible for itself and Full Disk Access had to be granted to
  // ~/.hazlie/bin/node — a unix binary, found through a file picker, listed in
  // System Settings under a name nobody installed. Spawned by the app, the app
  // is responsible, so the grant is one row called Intaglio Labs and the same
  // inheritance covers the Contacts, Calendar and Photos prompts.
  private static let agentsInOrder = ["io.intaglio.hermes", "io.intaglio.llama-server", "io.intaglio.connect"]

  /// Remove a connectors agent left behind by an older install. Without this it
  /// keeps running under launchd — responsible for itself, needing its own FDA,
  /// and racing the app's child for the same cursors and caches.
  static func retireConnectorsAgent() {
    // BOTH namespaces, because "an older install" now includes one from before
    // the com.hazlie.* -> io.intaglio.* rename (2026-08-25). Dropping the old
    // label here would leave a pre-rename agent running under launchd forever:
    // responsible for itself, needing its own FDA, and racing the app's child
    // for the same cursors and caches — exactly what this function exists to
    // prevent, silently reintroduced by the rename.
    for label in ["io.intaglio.connectors", "com.hazlie.connectors"] {
      let plist = launchAgents.appendingPathComponent("\(label).plist")
      guard fm.fileExists(atPath: plist.path) else { continue }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
      p.arguments = ["bootout", "gui/\(getuid())/\(label)"]
      try? p.run()
      p.waitUntilExit()
      try? fm.removeItem(at: plist)
      NSLog("Intaglio Labs: retired the \(label) launchd agent; it runs as a child now")
    }
  }

  /// Retire an io.intaglio.bridges agent a previous install left behind.
  ///
  /// Skipping the INSTALL is not enough on an upgrade, and that is the whole
  /// reason this exists: launchd already holds the job from before the bridges
  /// feature went dormant, the plist carries RunAtLoad + KeepAlive, and it
  /// comes back every login supervising a stack nothing on the card reads.
  ///
  /// Shaped like retireConnectorsAgent — bootout, then remove the plist so it
  /// cannot be re-bootstrapped at the next login. It deliberately deletes NO
  /// DATA: ~/.hazlie/matrix, ~/.hazlie/bridges and the owner credentials inside
  /// them stay where they are, so turning `bridges` back on is a flag flip and a
  /// relaunch, not a re-download and seven re-logins. Stage 1 is dormancy, not
  /// removal.
  static func retireBridgesAgent() {
    let label = "io.intaglio.bridges"
    let plist = launchAgents.appendingPathComponent("\(label).plist")
    guard fm.fileExists(atPath: plist.path) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["bootout", "gui/\(getuid())/\(label)"]
    try? p.run()
    p.waitUntilExit()
    try? fm.removeItem(at: plist)
    NSLog("Intaglio Labs: retired the \(label) launchd agent; the bridges feature is off "
          + "(its data under ~/.hazlie/matrix and ~/.hazlie/bridges is untouched)")
  }

  /// Retire the backend jobs installed before the bundle identifier moved
  /// from com.hazlie.* to io.intaglio.*. The new plists are installed first;
  /// only then are these working fallbacks removed, so a failed upgrade never
  /// trades a running backend for none at all.
  private static func retireLegacyBackendAgents() -> Bool {
    var retired = false
    let migrations = [
      ("com.hazlie.hermes", "io.intaglio.hermes"),
      ("com.hazlie.llama-server", "io.intaglio.llama-server"),
      ("com.hazlie.connect", "io.intaglio.connect"),
    ]
    for (legacy, replacement) in migrations {
      let plist = launchAgents.appendingPathComponent("\(legacy).plist")
      let replacementPlist = launchAgents.appendingPathComponent("\(replacement).plist")
      guard fm.fileExists(atPath: plist.path),
            fm.fileExists(atPath: replacementPlist.path) else { continue }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
      p.arguments = ["bootout", "gui/\(getuid())/\(legacy)"]
      try? p.run()
      p.waitUntilExit()
      try? fm.removeItem(at: plist)
      retired = true
      NSLog("Intaglio Labs: retired legacy backend agent \(legacy)")
    }
    return retired
  }

  /// Jobs may have attempted to start while their legacy counterparts still
  /// owned the ports. Restart every installed new job after migration.
  private static func restartInstalledBackendAgents() {
    for label in agentsInOrder {
      let plist = launchAgents.appendingPathComponent("\(label).plist")
      if fm.fileExists(atPath: plist.path) { kickstart(label) }
    }
  }
  // The llama plist hard-codes Homebrew's binary path; provision points it at
  // the stable copy instead -- ~/.hazlie/llama/llama-server, beside the ggml
  // backend modules it dlopens through @loader_path.
  private static let brewLlama = "/opt/homebrew/bin/llama-server"
  private static let defaultModelFilename = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"

  private static func modelID(_ filename: String) -> String {
    URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent
  }

  private static func inferenceValues() -> [String: String] {
    let profile = InferenceTuning.selected()
    let mainFilename = ModelSetup.installed?.file ?? defaultModelFilename
    return [
      "@LLAMA_CTX_SIZE@": String(profile.contextSize),
      "@LLAMA_PARALLEL@": String(profile.parallel),
      "@LLAMA_BATCH_SIZE@": String(profile.batchSize),
      "@LLAMA_UBATCH_SIZE@": String(profile.microBatchSize),
      "@LLAMA_MODELS_MAX@": String(profile.modelsMax),
      "@LLAMA_MAIN_MODEL@": modelID(mainFilename),
    ]
  }

  @discardableResult
  private static func prepareModelRouter() -> Bool {
    guard let main = ModelSetup.installed else { return false }
    let modelDir = hazlie.appendingPathComponent("models")
    let router = modelDir.appendingPathComponent("router")
    do {
      try mkdir(router, 0o700)
      for tier in ModelSetup.tiers {
        let link = router.appendingPathComponent(tier.file)
        try? fm.removeItem(at: link)
        let source = modelDir.appendingPathComponent(tier.file)
        guard tier.file == main.file else { continue }
        try fm.createSymbolicLink(at: link, withDestinationURL: source)
      }
      return true
    } catch {
      NSLog("Intaglio Labs: model router setup failed: \(error)")
      return false
    }
  }

  // Call once at launch. Runs off the main thread — copying node and booting
  // launchd agents should not block the UI coming up.

  /// Ensure the connector daemon has its minimum config before anything tries
  /// to start it. A downloaded app used to create this file only if onboarding
  /// reached one particular button, so skipping/resuming that scene left every
  /// connector permanently parked after an otherwise successful provision.
  ///
  /// A newly-created connector identity also starts WhatsApp OFF. WhatsApp's
  /// Desktop database belongs to WhatsApp, not to Intaglio Labs, and survives a
  /// Intaglio Labs wipe. Treating its mere presence as prior consent made a truly fresh
  /// install paint WhatsApp green before the owner had selected it. The marker
  /// is removed only by the explicit Connect button in the connections UI.
  @discardableResult
  static func ensureConnectorDefaults() -> Bool {
    let dir = hazlie.appendingPathComponent("connectors")
    let config = dir.appendingPathComponent("config.json")
    if fm.fileExists(atPath: config.path) { return true }
    do {
      try mkdir(hazlie, 0o700)
      try mkdir(dir, 0o700)
      let whatsapp = dir.appendingPathComponent("whatsapp.disabled")
      if !fm.fileExists(atPath: whatsapp.path) {
        try Data().write(to: whatsapp, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: whatsapp.path)
      }

      // Config is the completion marker and is deliberately written last. If
      // anything above fails, the next launch retries instead of seeing a config
      // and skipping the consent marker that should accompany its creation.
      try "{}\n".write(to: config, atomically: true, encoding: .utf8)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
      return true
    } catch {
      NSLog("Intaglio Labs: connector defaults failed: \(error)")
      return false
    }
  }

  /// Serialises the llama repair below. ensureBackend hops to a global queue,
  /// so two calls in one launch run their bodies concurrently.
  private static let llamaRepairLock = NSLock()
  /// Set only by an install that SUCCEEDED — see repairLlamaAgent.
  private static var llamaRepairAttempted = false
  /// When a failed attempt may be made again, and how many have failed. Both
  /// are read and written under llamaRepairLock.
  private static var llamaRepairNotBefore = Date.distantPast
  private static var llamaRepairFailures = 0
  /// 30 s, doubling to a ten-minute ceiling. Long enough that a `launchctl
  /// bootstrap` racing a previous bootout has finished, short enough that the
  /// next ensureBackend() of an ordinary session gets another go.
  private static let llamaRepairBackoffFloor: TimeInterval = 30
  private static let llamaRepairBackoffCeiling: TimeInterval = 600

  /// AND THE ONE AGENT PROVISIONING CAN LEGITIMATELY SKIP. provision() installs
  /// the llama agent only when a model is present, and an install that once
  /// read as "no weights" (the relative-link bug fixed in ModelSetup.installed
  /// on 2026-09-12, or weights that arrived later by hand) keeps the connect
  /// plist that ends ensureBackend's first branch early -- so a Mac with
  /// weights and no llama agent would stay that way for ever.
  ///
  /// ONCE PER LAUNCH, UNDER A LOCK. installAgent boots the agent OUT and then
  /// bootstraps it back in; two concurrent ensureBackend() calls would both
  /// pass the "no plist" test and interleave those, so the second bootout can
  /// land on the first bootstrap and leave the agent absent — the state this
  /// repair exists to end. The lock is held across installAgent rather than
  /// only around the flag, because it is the launchctl pair that must not
  /// interleave, and the weights-and-no-plist guard comes first: weights that
  /// arrive later in the same session still get their agent from a later call.
  ///
  /// ONCE IS ONCE PER SUCCESS, NOT ONCE PER TRY (round-5 finding 21). The flag
  /// was set before installAgent ran, so a `launchctl bootstrap` that failed
  /// transiently — most likely against an agent still booting out from the run
  /// before — burnt the launch's only attempt, and ensureBackend calling again
  /// five minutes later did nothing. A failure now leaves the flag clear and
  /// puts a backoff in front of the next try, so the interleaving guarantee is
  /// unchanged (the lock, not the flag, is what provides it) and the one-shot
  /// loss is gone.
  private static func repairLlamaAgent() {
    llamaRepairLock.lock()
    defer { llamaRepairLock.unlock() }
    guard !llamaRepairAttempted, Date() >= llamaRepairNotBefore else { return }
    let llamaPlist = launchAgents.appendingPathComponent("io.intaglio.llama-server.plist")
    guard ModelSetup.isInstalled, !fm.fileExists(atPath: llamaPlist.path) else { return }
    if installAgent("io.intaglio.llama-server") {
      llamaRepairAttempted = true
      llamaRepairFailures = 0
      NSLog("Intaglio Labs: installed the llama agent for weights that were already here")
    } else {
      llamaRepairFailures += 1
      let delay = min(
        llamaRepairBackoffCeiling,
        llamaRepairBackoffFloor * pow(2, Double(llamaRepairFailures - 1))
      )
      llamaRepairNotBefore = Date().addingTimeInterval(delay)
      NSLog("Intaglio Labs: llama agent install failed (\(llamaRepairFailures)); retrying in \(Int(delay))s")
    }
  }

  /// WHAT A RELAUNCH SHOULD DO ABOUT ONE INSTALLED AGENT, as a pure function of
  /// the two facts that decide it. Separate from the launchctl calls so the
  /// decision can be read and tested without a launchd on the other end.
  enum AgentAction: String {
    /// No plist here. Provisioning and installAgent own that case, not this
    /// repair — inventing an agent would be a different function's job.
    case notInstalled
    /// launchd has it. Nothing to do, and deliberately NOT a kickstart: a
    /// running service is not something a launch gets to bounce.
    case loaded
    /// The plist is here and launchd does not have the job. Put it back.
    case bootstrap
    /// The probe could not answer. Not the same as "loaded", and deliberately
    /// its own case rather than a Bool defaulted one way: what it justifies is
    /// doing nothing this launch, and a reader should be able to see that
    /// without working out which way a default fell.
    case unknown
  }

  static func agentAction(plistExists: Bool, loaded: Bool?) -> AgentAction {
    guard plistExists else { return .notInstalled }
    guard let loaded else { return .unknown }
    return loaded ? .loaded : .bootstrap
  }

  /// How long launchctl gets to answer one question about one label.
  private static let agentProbeTimeout: TimeInterval = 3

  /// DOES THIS PLIST STILL POINT AT FILES THAT ARE THERE?
  ///
  /// Pure, with the filesystem injected, so the rule can be exercised over every
  /// shape of ProgramArguments rather than only read.
  ///
  /// Round-1 review, finding 5: without it, a plist that names a path nothing
  /// lives at any more is bootstrapped on EVERY launch, for ever — launchd
  /// accepts the job, the job dies, and the next launch finds it unloaded and
  /// tries again. That is the shape a stale plist takes after the app moves, and
  /// it is a repair that can never converge. Such a plist wants re-rendering from
  /// the bundle's template (installAgent), not re-bootstrapping.
  ///
  /// THE FIRST TWO ARGUMENTS ONLY: the interpreter and what it runs. Everything
  /// after them is flags and flag values, and llama-server's include a
  /// models directory that legitimately appears later; treating one of those as
  /// proof of staleness would send a healthy agent round the rewrite path.
  /// Non-absolute entries are skipped for the same reason — they are not paths
  /// this can check. An argument list with no absolute path in its first two
  /// entries is not one this rule can vouch for, so it says so.
  static func agentProgramPathsExist(
    programArguments: [String], fileExists: (String) -> Bool
  ) -> Bool {
    let paths = programArguments.prefix(2).filter { $0.hasPrefix("/") }
    guard !paths.isEmpty else { return false }
    return paths.allSatisfy(fileExists)
  }

  /// The installed plist's ProgramArguments, or nil if it cannot be read or
  /// parsed — which is itself a reason to re-render rather than bootstrap.
  private static func programArguments(of plist: URL) -> [String]? {
    guard let data = try? Data(contentsOf: plist),
          let root = try? PropertyListSerialization
            .propertyList(from: data, format: nil) as? [String: Any],
          let args = root["ProgramArguments"] as? [String], !args.isEmpty
    else { return nil }
    return args
  }

  /// Is `label` a job launchd currently knows about? `nil` is "could not tell".
  ///
  /// `launchctl print` rather than `launchctl list`: list prints EVERY job on the
  /// Mac and has to have its pipe drained before the wait or it deadlocks on a
  /// full buffer (Uninstall.loadedLabels carries that trap in a comment). With
  /// three labels to ask about, a per-label probe with both streams discarded is
  /// smaller in every direction.
  ///
  /// BOUNDED, because `waitUntilExit` is not (round-1 review, finding 7). This
  /// runs on a launch path, and the machine where launchctl is wedged or launchd
  /// is slow to answer is exactly the machine where an unbounded wait is worst.
  /// Three seconds is far more than a local `print` needs and short enough that
  /// three of them cannot add up to anything an owner notices.
  ///
  /// A launchctl we could not run, and one that did not answer in time, both
  /// return nil — so a probe that failed leads to no action rather than to a
  /// bootstrap on a guess.
  private static func probeAgentLoaded(_ label: String) -> Bool? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["print", "gui/\(getuid())/\(label)"]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let deadline = Date().addingTimeInterval(agentProbeTimeout)
    while p.isRunning, Date() < deadline { usleep(50_000) }
    guard !p.isRunning else {
      p.terminate()
      NSLog("Intaglio Labs: launchctl did not say whether \(label) is loaded in "
            + "\(Int(agentProbeTimeout))s — leaving it alone")
      return nil
    }
    return p.terminationStatus == 0
  }

  /// A PLIST ON DISK IS NOT A SERVICE LAUNCHD IS RUNNING, and until now this
  /// file only ever asked the first question.
  ///
  /// ensureBackend's fast path returns the moment `io.intaglio.connect.plist`
  /// exists, and every other install path bootstraps only at the moment it
  /// WRITES a plist. So a machine whose agents have been booted out with their
  /// plists left in place stays that way across quit and relaunch: on 2026-09-14
  /// `launchctl bootout gui/501/io.intaglio.hermes` and `...connect` by hand left
  /// only llama-server and the app in `launchctl list`, and quitting and
  /// relaunching brought neither back. The connectors child then failed its
  /// connect-health preflight (127.0.0.1:51788/api/status unreachable) and logged
  /// `daemon_failed_to_start`; a manual `launchctl bootstrap` of both plists was
  /// the whole fix. The plists name a path and launchd reloads them at login, so
  /// the state also heals itself at the next LOGIN — which is a long time to have
  /// no database.
  ///
  /// SEEN BY HAND, AND REACHABLE WITHOUT HANDS. Nothing in the app boots a
  /// service out and leaves its plist on purpose: Uninstall.run removes the plist
  /// straight after the bootout. But it appends a failure and CONTINUES when that
  /// removal throws ("was stopped but its plist stayed"), and a failed uninstall
  /// deliberately leaves the app running — which is exactly this state, in
  /// product, with the owner still using it.
  ///
  /// Cheap and idempotent: three `launchctl print`s on a healthy Mac, no
  /// subprocess at all for an agent whose plist is absent, and no kickstart of
  /// anything that is already up. The connectors child needs no special handling
  /// — its preflight failure respawns it after 4, 8 then 16 seconds, by which
  /// time these have landed.
  ///
  /// AND IT DOES NOT WAIT FOR HERMES (round-1 review, finding 5). provision()
  /// does, because provision() goes on to bootstrap connect and hand the reader
  /// a database in the same pass. Nothing in THIS function talks to hermes
  /// afterwards, and `launchctl bootstrap` returns as soon as launchd has
  /// accepted the job rather than when the process is serving — so the wait
  /// bought no ordering here, only up to fifteen seconds of a launch path on
  /// exactly the Mac that is already unwell.
  private static func bootstrapUnloadedAgents() {
    for label in agentsInOrder {
      let plist = launchAgents.appendingPathComponent("\(label).plist")
      let exists = fm.fileExists(atPath: plist.path)
      // Short-circuited: no plist, no launchctl call.
      switch agentAction(plistExists: exists, loaded: exists ? probeAgentLoaded(label) : nil) {
      case .notInstalled, .loaded, .unknown:
        continue
      case .bootstrap:
        // A PLIST THAT NAMES SOMETHING THAT IS NOT THERE cannot be repaired by
        // bootstrapping it: launchd takes the job, the job dies, and the next
        // launch finds it unloaded and does the same thing again, for ever.
        // Re-rendered from the bundle's template instead, which is what fixes
        // the paths. installAgent boots out first, which is a no-op here.
        guard let args = programArguments(of: plist),
              agentProgramPathsExist(programArguments: args,
                                     fileExists: { fm.fileExists(atPath: $0) })
        else {
          NSLog("Intaglio Labs: \(label) is installed, not loaded, and points at "
                + "something that is gone — re-rendering it rather than bootstrapping")
          if !installAgent(label) {
            NSLog("Intaglio Labs: could not re-render \(label) from the bundle")
          }
          continue
        }
        NSLog("Intaglio Labs: \(label) is installed but not loaded — bootstrapping it")
        bootstrap(plist)
      }
    }
  }

  static func ensureBackend() {
    DispatchQueue.global(qos: .utility).async {
      let connectPlist = launchAgents.appendingPathComponent("io.intaglio.connect.plist")
      guard !fm.fileExists(atPath: connectPlist.path) else {
        // Already provisioned (owner's setup or a previous run) — but still
        // heal a missing secret: installs provisioned by a build that only
        // wrote hermes-token.txt have this plist yet lack llama-api-key.txt,
        // leaving hermes and llama-server crash-looping under KeepAlive.
        // Existing files are never touched, so this is a no-op when healthy.
        do { try ensureSecrets() }
        catch { NSLog("Intaglio Labs: secret provisioning failed: \(error)") }
        repairLlamaAgent()
        // AND THE AGENTS THAT ARE INSTALLED BUT NOT RUNNING. The guard above
        // asks whether a PLIST exists, which is not the same question as
        // whether launchd has the job — see bootstrapUnloadedAgents.
        bootstrapUnloadedAgents()
        if retireLegacyBackendAgents() { restartInstalledBackendAgents() }
        return
      }
      guard fm.fileExists(atPath: backend.appendingPathComponent("connect/server.mjs").path) else {
        NSLog("Intaglio Labs: no bundled backend — a dev build without it, skipping provision")
        return
      }
      do {
        try provision()
        if retireLegacyBackendAgents() { restartInstalledBackendAgents() }
      }
      catch { NSLog("Intaglio Labs: provisioning failed: \(error)") }
    }
  }

  /// Warm the native bridge runtime after launch, without creating any social
  /// state. The expensive part -- ~305 MB of hash-checked bridge binaries and
  /// the Synapse runtime build -- happens before a person chooses LinkedIn (or
  /// another social source), while the actual Matrix/bridge setup stays
  /// deferred until that explicit Connect action. Every step is idempotent, so
  /// a launch that gets interrupted is retried by the next one and, failing
  /// that, by setup itself.
  static func prefetchBridgeRuntime() {
    // THE FEATURE REGISTRY DECIDES, and when it says no this is also the place
    // an already-installed agent gets retired — this runs on every launch from
    // main.swift, which is the only hook an upgraded machine reliably reaches.
    guard Features.shouldPrefetchBridgeRuntime(Features.current) else {
      NSLog("Intaglio Labs: bridges are off — skipping the bridge runtime prefetch")
      // OFF THE MAIN THREAD, because retiring is not free.
      //
      // This call used to sit here bare, and prefetchBridgeRuntime() is invoked
      // synchronously from applicationDidFinishLaunching. retireBridgesAgent
      // does p.run() + p.waitUntilExit() on `launchctl bootout` of a KeepAlive
      // supervisor that owns Synapse and seven mautrix children — so the first
      // launch after upgrading a machine that HAD bridges installed beachballed
      // for however long that teardown takes. The cost lands on exactly the
      // install that stage 1 was meant to make lighter.
      //
      // main.swift does the same thing with retireConnectorsAgent() for the
      // same reason; this follows that precedent rather than inventing a
      // second shape. Still idempotent: the plist-existence guard inside
      // retireBridgesAgent means a launch that raced or repeated it is a no-op,
      // and nothing here waits on the result.
      if Features.shouldRetireBridgesAgent(Features.current) {
        DispatchQueue.global(qos: .utility).async { retireBridgesAgent() }
      }
      return
    }
    let script = backend.appendingPathComponent("ops/prefetch-bridges.sh")
    guard fm.fileExists(atPath: script.path) else {
      NSLog("Intaglio Labs: bundled bridge prefetch script is missing")
      return
    }
    guard fm.isExecutableFile(atPath: script.path) else {
      NSLog("Intaglio Labs: bundled bridge prefetch script is not executable")
      return
    }
    DispatchQueue.global(qos: .utility).async {
      let logDir = hazlie.appendingPathComponent("logs")
      try? mkdir(logDir, 0o700)
      let log = logDir.appendingPathComponent("bridge-prefetch.log")
      guard fm.createFile(atPath: log.path, contents: nil),
            let out = try? FileHandle(forWritingTo: log) else { return }
      defer { try? out.close() }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/sh")
      p.arguments = [script.path]
      var env = ProcessInfo.processInfo.environment
      env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
      p.environment = env
      p.standardOutput = out
      p.standardError = out
      do {
        try p.run()
        p.waitUntilExit()
        // Existing bridge installs need setup-bridges to apply versioned
        // migrations too. Fresh installs have no owner credentials and remain
        // consent-deferred; their first connector click still owns setup.
        // One bridge state root. A second (~/.hazlie/matrix-docker) existed
        // briefly, while a Docker fallback did; both are gone.
        let matrixRoot = hazlie.appendingPathComponent("matrix")
        let existingRuntime = matrixRoot.appendingPathComponent("owner-credentials.json")
        let historyMigration = matrixRoot.appendingPathComponent(".full-history-reset-v1")
        let historyMigrationPending = matrixRoot.appendingPathComponent(".full-history-reset-v1.pending")
        if p.terminationStatus == 0,
           fm.fileExists(atPath: historyMigrationPending.path)
             || (fm.fileExists(atPath: existingRuntime.path)
                 && !fm.fileExists(atPath: historyMigration.path)) {
          ensureBridgeRuntime { _ in }
        }
      } catch {
        NSLog("Intaglio Labs: bridge prefetch could not start: \(error)")
      }
    }
  }

  private static let bridgeSetupLock = NSLock()
  private static var bridgeSetupRunning = false
  private static var bridgeSetupWaiters: [(Bool) -> Void] = []

  /// Materialize the local-only Matrix runtime after someone explicitly starts
  /// a social login. Image downloads were already warmed on launch; this is
  /// the small, user-requested half that writes private state under ~/.hazlie
  /// and starts the requested bridge stack. Concurrent card presses join the
  /// same run rather than racing two installers against one data directory.
  static func ensureBridgeRuntime(_ completion: @escaping (Bool) -> Void) {
    // Second gate, not a duplicate of prefetch's: this one is reachable from a
    // Connect press on the connections page (Bridge.swift) as well as from the
    // prefetch, and it is the call that actually runs setup-bridges-native.sh —
    // which is what installs io.intaglio.bridges. Refusing HERE is what keeps
    // the agent off the machine.
    guard Features.shouldEnsureBridgeRuntime(Features.current) else {
      NSLog("Intaglio Labs: bridges are off — refusing to provision the Matrix runtime")
      DispatchQueue.main.async { completion(false) }
      return
    }
    bridgeSetupLock.lock()
    bridgeSetupWaiters.append(completion)
    if bridgeSetupRunning {
      bridgeSetupLock.unlock()
      return
    }
    bridgeSetupRunning = true
    bridgeSetupLock.unlock()

    DispatchQueue.global(qos: .userInitiated).async {
      // NATIVE, AND ONLY NATIVE.
      //
      // One Synapse and seven mautrix bridges, run as launchd agents on this
      // Mac. Docker Desktop was carried for a year because the bridges were
      // believed to need it; they do not. Every bridge is Go with a published
      // darwin-arm64 binary and matrix-synapse publishes a macOS arm64 wheel.
      // Verified end to end on 2026-08-30: all seven bridges plus Synapse
      // running with Docker never started, three real social logins delivered,
      // thousands of messages ingested.
      //
      // The Docker fallback is GONE, deliberately, and it is worth writing down
      // why a safety net was removed rather than kept. It was never reachable:
      // the native script returned 0 whether it started seven bridges or none,
      // so `where !success` never fired. When that was fixed the fallback got
      // worse, not better -- Docker Desktop on macOS is a Linux VM, so "native
      // failed" resolved to "silently install and boot a virtual machine",
      // which is precisely the outcome this work existed to remove. A fallback
      // nobody would consent to is not a safety net.
      //
      // What replaces it is the script being honest. setup-bridges-native.sh
      // bootstraps itself -- fetches the published binaries hash-checked, takes
      // the libolm the bundle ships, builds the Synapse runtime from wheels --
      // and needs no toolchain here, only network, once. If that cannot
      // complete it now tears down anything it started and exits non-zero, and
      // the reason is in bridge-setup.log instead of being papered over by a VM.
      let nativeScript = backend.appendingPathComponent("ops/setup-bridges-native.sh")
      let scripts = [nativeScript]
      var success = false
      let logDir = hazlie.appendingPathComponent("logs")
      try? mkdir(logDir, 0o700)
      let log = logDir.appendingPathComponent("bridge-setup.log")
      if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil) }
      // Every attempt is written to bridge-setup.log with the script that ran,
      // so what provisioned this machine is a fact in a file.
      for candidate in scripts where !success {
        guard fm.isExecutableFile(atPath: candidate.path) else { continue }
        guard let out = try? FileHandle(forWritingTo: log) else { continue }
        defer { try? out.close() }
        _ = try? out.seekToEnd()
        let banner = "\n=== \(Date()) running \(candidate.lastPathComponent) ===\n"
        if let data = banner.data(using: .utf8) { out.write(data) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [candidate.path]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        p.environment = env
        p.standardOutput = out
        p.standardError = out
        do {
          try p.run()
          p.waitUntilExit()
          success = p.terminationStatus == 0
        } catch {
          NSLog("Intaglio Labs: bridge setup could not start: \(error)")
        }
      }
      bridgeSetupLock.lock()
      let waiters = bridgeSetupWaiters
      bridgeSetupWaiters.removeAll()
      bridgeSetupRunning = false
      bridgeSetupLock.unlock()
      DispatchQueue.main.async {
        // setup-bridges may have written a one-time corpus-reset marker. The
        // daemon consumes it before scheduling reads, so respawn it before any
        // newly recreated portal can be indexed.
        if success { Connectors.shared.restart() }
        waiters.forEach { $0(success) }
      }
    }
  }

  private static func provision() throws {
    // 0700 private root and its subdirs.
    try mkdir(hazlie, 0o700)
    for sub in ["bin", "lib", "secrets", "logs", "connectors", "context", "models"] {
      try mkdir(hazlie.appendingPathComponent(sub), 0o700)
    }
    try mkdir(launchAgents, 0o755)

    // node + its libnode → the STABLE path. Full Disk Access attaches to this
    // exact binary, so it must live outside the app bundle (which re-signs on
    // every update). Copied once; left alone if present, to keep the grant.
    let stableNode = hazlie.appendingPathComponent("bin/node")
    if !fm.fileExists(atPath: stableNode.path) {
      try fm.copyItem(at: backend.appendingPathComponent("node/bin/node"), to: stableNode)
      try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stableNode.path)
    }
    let bundledLib = backend.appendingPathComponent("node/lib")
    if let libs = try? fm.contentsOfDirectory(at: bundledLib, includingPropertiesForKeys: nil) {
      for lib in libs where lib.lastPathComponent.hasPrefix("libnode") {
        let dst = hazlie.appendingPathComponent("lib/\(lib.lastPathComponent)")
        if !fm.fileExists(atPath: dst.path) { try fm.copyItem(at: lib, to: dst) }
      }
    }

    // The llama runtime: the server -> ~/.hazlie/bin, its dylibs -> ~/.hazlie/
    // lib (sharing the dir with libnode; the binary's @loader_path/../lib rpath
    // finds them), and the ~4.7GB model -> ~/.hazlie/models. The model is
    // cloned (cp -c: instant copy-on-write on the same APFS volume) rather than
    // read+written. All left alone if already present.
    // FLAT, and it has to stay flat. llama.cpp's own release puts the server
    // and every ggml backend module in ONE directory with an rpath of
    // @loader_path; they find each other by sitting together. The previous
    // layout split them into ~/.hazlie/bin and ~/.hazlie/lib, which is exactly
    // the arrangement that stops the backends being found -- see the header of
    // widget/bundle-llama.py for what that cost.
    let llamaSrc = backend.appendingPathComponent("llama/bin")
    let llamaDst = hazlie.appendingPathComponent("llama")
    if fm.fileExists(atPath: llamaSrc.appendingPathComponent("llama-server").path) {
      try? mkdir(llamaDst, 0o700)
      if let staged = try? fm.contentsOfDirectory(at: llamaSrc, includingPropertiesForKeys: nil) {
        for file in staged {
          let dst = llamaDst.appendingPathComponent(file.lastPathComponent)
          // REPLACE, do not skip-if-present. The old code copied only when the
          // destination was absent, so an upgrade never refreshed the runtime:
          // the owner's stayed on a build from a week earlier and broke when
          // Homebrew moved out from under it. There is nothing user-owned in
          // this directory to preserve.
          try? fm.removeItem(at: dst)
          try? fm.copyItem(at: file, to: dst)
        }
      }
      try? fm.setAttributes([.posixPermissions: 0o755],
                            ofItemAtPath: llamaDst.appendingPathComponent("llama-server").path)
      let model = backend.appendingPathComponent("models/model.gguf")
      let stableModel = hazlie.appendingPathComponent("models/model.gguf")
      if fm.fileExists(atPath: model.path), !fm.fileExists(atPath: stableModel.path) {
        clone(model, stableModel)
      }
    }

    // The voice models (ear STT + speak TTS): ~495MB bundled at backend/
    // voice-models, cloned to ~/.hazlie/models/voice — the exact tree
    // AssetScheme serves to the ear page (models/, vendor/, workers/). The ear
    // fails CLOSED without these (no HuggingFace fallback at runtime), so a
    // fresh Mac has no voice unless they are present. Cloned as a whole tree
    // (cp -c -R) and left alone if the directory already exists.
    //
    // GATED ON `voice` (stage 1). The models still ship in the bundle — taking
    // them out is stage 2 — but a fresh install no longer grows ~495 MB in
    // ~/.hazlie for a feature whose tap is a tease. Turning `voice` back on and
    // relaunching clones them, because provision() is not the only caller that
    // can: this is idempotent and skip-if-present either way.
    let voiceSrc = backend.appendingPathComponent("voice-models")
    let voiceDst = hazlie.appendingPathComponent("models/voice")
    if Features.shouldCloneVoiceModels(Features.current) {
      if fm.fileExists(atPath: voiceSrc.path), !fm.fileExists(atPath: voiceDst.path) {
        cloneTree(voiceSrc, voiceDst)
      }
    } else {
      NSLog("Intaglio Labs: voice is off — skipping the voice-model clone")
    }

    // BOTH owner-only secrets, 0600, each left alone if already there. The body
    // lives in ensureSecrets() because ensureBackend() has to run it on an
    // already-provisioned launch too, which never reaches provision().
    try ensureSecrets()

    // Render each plist (@HOME@ → home, @REPO@ → the bundle's backend), write
    // it 0644, and bootstrap. Wait for hermes to answer /health before the
    // rest, so connectors don't write into a database still opening.
    // What llama-server needs is WEIGHTS, and the check used to be for the
    // BINARY. That was right while the two shipped together: the runtime was
    // bundled only when the build machine also had a model. Now the runtime
    // always ships and the model is downloaded in onboarding, so the binary is
    // always present and the old condition passed on a machine with nothing to
    // load — the agent registered, launchd started it, and it died on a missing
    // model instead of a missing binary. Same wasted background item, one exit
    // code further along.
    //
    // The honest question is whether this agent can do its job, and the answer
    // is the model.gguf link. Onboarding installs the agent itself the moment a
    // download lands, which is when it becomes true.
    let modelLink = hazlie.appendingPathComponent("models/model.gguf")
    for label in agentsInOrder {
      if label == "io.intaglio.llama-server" && !fm.fileExists(atPath: modelLink.path) {
        NSLog("Intaglio Labs: no model yet — skipping the llama agent until one is chosen")
        continue
      }
      installAgent(label)
      if label == "io.intaglio.hermes" { waitForHermes() }
    }
    NSLog("Intaglio Labs: provisioned backend from the app bundle")
  }

  // BOTH owner-only secrets, 0600, each left alone if already there.
  //
  // The llama key used to be missing here, and hermes would not start without
  // it: readLlamaApiKey() throws at boot, so a fresh install died with
  // "llama API key file is missing; run ops/setup-llm.sh" -- pointing at a
  // script a downloaded app does not have. Everything downstream went with it,
  // because hermes is the database. Found on a genuinely fresh Mac: the widget
  // came up, connect came up, and hermes sat at exit status 1.
  //
  // Generating it here is safe in both directions. setup-llm.sh preserves an
  // existing key when it runs (it stamps the active one and only regenerates
  // when absent), and llama-server is handed the same file whenever it does
  // arrive -- bundled at build time, or installed later. The key is required
  // for hermes to BOOT, not just to reach a model, so it cannot wait for one.
  //
  // Which is why this is a function rather than a few lines inside provision():
  // provision() is skipped the moment the connect agent exists, so a machine
  // provisioned by a build that only wrote hermes-token.txt would never gain
  // the llama key and would crash-loop under KeepAlive forever. ensureBackend()
  // calls this on EVERY launch, including that already-provisioned one, and
  // per-file "leave it alone if it exists" keeps a healthy machine a no-op.
  private static func ensureSecrets() throws {
    try mkdir(hazlie.appendingPathComponent("secrets"), 0o700)
    for name in ["hermes-token.txt", "llama-api-key.txt"] {
      let file = hazlie.appendingPathComponent("secrets/\(name)")
      guard !fm.fileExists(atPath: file.path) else { continue }
      var bytes = [UInt8](repeating: 0, count: 32)
      // CHECKED, and it has to be. On failure the array stays all zeros and this
      // writes 64 hex zeros -- a syntactically valid, fully predictable credential
      // that hermes' validateHexKey accepts, guarding the corpus-admin surface
      // with a known value. Every other generator in this tree fails closed
      // (openssl under set -e, node randomBytes throws); this one fails open, on
      // the most privileged credential. Abort provisioning instead.
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw NSError(domain: "Provision", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "SecRandomCopyBytes failed generating \(name)"])
      }
      // TRAILING NEWLINE, and it is not cosmetic. ops/setup-llm.sh validates both
      // of these files with `wc -l` -- which counts NEWLINES, not lines -- because
      // it writes them itself with `openssl rand -hex 32 >`, which leaves one. A
      // file holding the same 64 hex characters with no newline counts as 0 and is
      // rejected: "is not one generated 256-bit hex key".
      //
      // So a machine provisioned by the app could not afterwards run setup-llm.sh
      // to add a model -- it bailed on the key the app had just written. hermes
      // itself never noticed, because it trims. Matching the script's exact bytes
      // is what makes the two provisioning paths interoperable, which they have to
      // be: the app provisions first, and setup-llm.sh runs later to add the model.
      let secret = bytes.map { String(format: "%02x", $0) }.joined() + "\n"
      try secret.write(to: file, atomically: true, encoding: .utf8)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
  }

  private static func mkdir(_ url: URL, _ mode: Int) throws {
    try fm.createDirectory(at: url, withIntermediateDirectories: true,
                           attributes: [.posixPermissions: mode])
  }

  // Clone a file with cp -c (APFS copy-on-write): instant, no bytes moved, for
  // the multi-GB model. Falls back to a plain copy off-APFS.
  private static func clone(_ src: URL, _ dst: URL) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = ["-c", src.path, dst.path]
    try? p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { try? fm.copyItem(at: src, to: dst) }
  }

  // Clone a whole directory tree with cp -c -R (APFS copy-on-write): instant,
  // for the ~495MB voice model set. Falls back to a recursive copy off-APFS.
  private static func cloneTree(_ src: URL, _ dst: URL) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/cp")
    p.arguments = ["-c", "-R", src.path, dst.path]
    try? p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { try? fm.copyItem(at: src, to: dst) }
  }

  /// Copy the llama runtime out of the bundle to the stable ~/.hazlie paths.
  ///
  /// Separate from provision() because the two happen at different times and
  /// that gap was a bug. provision() no-ops once a machine is set up, so a
  /// binary the bundle gained LATER never came out: the plist was installed
  /// pointing at ~/.hazlie/bin/llama-server, nothing was there, and launchd
  /// parked the agent at exit 78 (EX_CONFIG) while onboarding sat on "checking
  /// it arrived intact" waiting for a service that could not spawn.
  ///
  /// Idempotent, and returns whether the binary is in place afterwards so the
  /// caller can refuse to install an agent that could only fail.
  @discardableResult
  static func ensureLlamaRuntime() -> Bool {
    // ONE FLAT DIRECTORY. The dylibs used to be dropped into ~/.hazlie/lib
    // beside libnode, on the reasoning that the binary's @loader_path/../lib
    // rpath would find them. It does find the LINKED ones -- and ggml's compute
    // backends are dlopen'd, not linked, and are only ever looked for beside
    // the executable. Splitting them is what left llama-server crash-looping on
    // "no backends are loaded". Keep them together.
    let srcDir = backend.appendingPathComponent("llama/bin")
    let dstDir = hazlie.appendingPathComponent("llama")
    let src = srcDir.appendingPathComponent("llama-server")
    let dst = dstDir.appendingPathComponent("llama-server")
    guard fm.fileExists(atPath: src.path) else { return fm.fileExists(atPath: dst.path) }
    try? mkdir(dstDir, 0o700)
    if let staged = try? fm.contentsOfDirectory(at: srcDir, includingPropertiesForKeys: nil) {
      for file in staged {
        let to = dstDir.appendingPathComponent(file.lastPathComponent)
        // Replace rather than skip-if-present: an upgrade has to be able to
        // refresh a runtime that a Homebrew move already broke once.
        try? fm.removeItem(at: to)
        try? fm.copyItem(at: file, to: to)
      }
    }
    try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.path)
    return fm.fileExists(atPath: dst.path)
  }

  /// Wait briefly for llama-server to answer. Bounded on purpose: a caller
  /// showing a person a progress screen must reach an ending, and "still
  /// checking" forever is the one outcome that is never true.
  static func waitForLlama(seconds: Int = 40) -> Bool {
    guard let url = URL(string: "http://127.0.0.1:51780/health") else { return false }
    for _ in 0..<seconds {
      var req = URLRequest(url: url)
      req.timeoutInterval = 2
      let sem = DispatchSemaphore(value: 0)
      var ok = false
      URLSession.shared.dataTask(with: req) { _, response, _ in
        ok = (response as? HTTPURLResponse)?.statusCode == 200
        sem.signal()
      }.resume()
      _ = sem.wait(timeout: .now() + 3)
      if ok { return true }
      Thread.sleep(forTimeInterval: 1)
    }
    return false
  }

  /// Render one agent's plist (@HOME@ → home, @REPO@ → the bundle's backend),
  /// write it 0644, and bootstrap it.
  ///
  /// Reachable on its own because agents do not all become installable at the
  /// same moment. llama-server is skipped at first run when there are no
  /// weights, and turns real later when onboarding finishes downloading a
  /// model — at which point this is what makes it exist, rather than asking the
  /// owner to relaunch the app.
  @discardableResult
  static func installAgent(_ label: String) -> Bool {
    let template = backend.appendingPathComponent("agents/\(label).plist")
    guard var text = try? String(contentsOf: template, encoding: .utf8) else { return false }
    text = text.replacingOccurrences(of: "@HOME@", with: home.path)
    text = text.replacingOccurrences(of: "@REPO@", with: backend.path)
    if label == "io.intaglio.llama-server" && !prepareModelRouter() { return false }
    for (placeholder, value) in inferenceValues() {
      text = text.replacingOccurrences(of: placeholder, with: value)
    }
    // The llama plist hard-codes Homebrew's binary; point it at the copy.
    text = text.replacingOccurrences(of: brewLlama, with: hazlie.appendingPathComponent("llama/llama-server").path)
    let dst = launchAgents.appendingPathComponent("\(label).plist")
    do {
      try mkdir(launchAgents, 0o755)
      try text.write(to: dst, atomically: true, encoding: .utf8)
    } catch {
      return false
    }
    try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dst.path)
    // launchd snapshots ProgramArguments and EnvironmentVariables at bootstrap;
    // replacing the plist alone leaves the old machine profile running.
    let out = Process()
    out.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    out.arguments = ["bootout", "gui/\(getuid())/\(label)"]
    try? out.run()
    out.waitUntilExit()
    bootstrap(dst)
    return true
  }

  /// Stop an agent and start it again from its current plist — what a changed
  /// model or key requires, and what setup-llm.sh does at the same point.
  static func kickstart(_ label: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["kickstart", "-k", "gui/\(getuid())/\(label)"]
    try? p.run()
    p.waitUntilExit()
  }

  private static func bootstrap(_ plist: URL) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["bootstrap", "gui/\(getuid())", plist.path]
    try? p.run()
    p.waitUntilExit()
  }

  // hermes /health is unauthenticated and answers exactly {"ok":true} once it
  // has migrated. Poll it briefly; proceed regardless (connectors retry) so a
  // slow start never wedges provisioning.
  private static func waitForHermes() {
    guard let url = URL(string: "http://127.0.0.1:51789/health") else { return }
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
      let sem = DispatchSemaphore(value: 0)
      var ok = false
      let task = URLSession.shared.dataTask(with: url) { data, resp, _ in
        if (resp as? HTTPURLResponse)?.statusCode == 200,
           let d = data, let s = String(data: d, encoding: .utf8),
           s.trimmingCharacters(in: .whitespacesAndNewlines) == "{\"ok\":true}" {
          ok = true
        }
        sem.signal()
      }
      task.resume()
      _ = sem.wait(timeout: .now() + 3)
      if ok { return }
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
