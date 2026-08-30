import Foundation

// First-run provisioning for a DOWNLOADED app: stand up the local backend
// (hermes, connect, connectors) from the code and node bundled inside the app,
// with no repo, no Homebrew, and no network. See widget/build.sh for what the
// bundle carries.
//
// SAFE BY DEFAULT. Once the connect agent exists in ~/Library/LaunchAgents —
// true on the owner's repo-based setup and after any prior provision — the
// whole copy-and-bootstrap path is skipped, so it never clobbers a working
// machine. The one thing every launch still ensures is the secret files
// (ensureSecrets): generation is per-file and only-if-missing, so installs
// provisioned by a build that predates llama-api-key.txt gain the key on
// upgrade instead of crash-looping forever, and a healthy machine sees a
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
  // the stable copy instead.
  private static let brewLlama = "/opt/homebrew/bin/llama-server"

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
    let llamaBin = backend.appendingPathComponent("llama/bin/llama-server")
    if fm.fileExists(atPath: llamaBin.path) {
      let stableLlama = hazlie.appendingPathComponent("bin/llama-server")
      if !fm.fileExists(atPath: stableLlama.path) {
        try fm.copyItem(at: llamaBin, to: stableLlama)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stableLlama.path)
      }
      let llamaLib = backend.appendingPathComponent("llama/lib")
      if let libs = try? fm.contentsOfDirectory(at: llamaLib, includingPropertiesForKeys: nil) {
        for lib in libs {
          let dst = hazlie.appendingPathComponent("lib/\(lib.lastPathComponent)")
          if !fm.fileExists(atPath: dst.path) { try? fm.copyItem(at: lib, to: dst) }
        }
      }
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
    let voiceSrc = backend.appendingPathComponent("voice-models")
    let voiceDst = hazlie.appendingPathComponent("models/voice")
    if fm.fileExists(atPath: voiceSrc.path), !fm.fileExists(atPath: voiceDst.path) {
      cloneTree(voiceSrc, voiceDst)
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
    let src = backend.appendingPathComponent("llama/bin/llama-server")
    let dst = hazlie.appendingPathComponent("bin/llama-server")
    guard fm.fileExists(atPath: src.path) else { return fm.fileExists(atPath: dst.path) }
    if !fm.fileExists(atPath: dst.path) {
      try? mkdir(hazlie.appendingPathComponent("bin"), 0o700)
      try? fm.copyItem(at: src, to: dst)
      try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.path)
    }
    // Its dylibs share ~/.hazlie/lib with libnode; the binary's
    // @loader_path/../lib rpath finds them there.
    let libSrc = backend.appendingPathComponent("llama/lib")
    if let libs = try? fm.contentsOfDirectory(at: libSrc, includingPropertiesForKeys: nil) {
      try? mkdir(hazlie.appendingPathComponent("lib"), 0o700)
      for lib in libs {
        let to = hazlie.appendingPathComponent("lib/\(lib.lastPathComponent)")
        if !fm.fileExists(atPath: to.path) { try? fm.copyItem(at: lib, to: to) }
      }
    }
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
    // The llama plist hard-codes Homebrew's binary; point it at the copy.
    text = text.replacingOccurrences(of: brewLlama, with: hazlie.appendingPathComponent("bin/llama-server").path)
    let dst = launchAgents.appendingPathComponent("\(label).plist")
    do {
      try mkdir(launchAgents, 0o755)
      try text.write(to: dst, atomically: true, encoding: .utf8)
    } catch {
      return false
    }
    try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dst.path)
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
