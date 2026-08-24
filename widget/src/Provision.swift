import Foundation
import AppKit

// First-run provisioning for a DOWNLOADED app: stand up the local backend
// (hermes, connect, connectors) from the code and node bundled inside the app,
// with no repo, no Homebrew, and no network. See widget/build.sh for what the
// bundle carries.
//
// SAFE BY DEFAULT. This no-ops the moment the connect agent already exists in
// ~/Library/LaunchAgents — which is true on the owner's repo-based setup and
// after any prior provision — so it never clobbers a working machine. It only
// does anything on a genuinely fresh install.
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
  private static let agentsInOrder = ["com.hazlie.hermes", "com.hazlie.llama-server", "com.hazlie.connect"]

  // WHATSAPP GOES STALE WITHOUT THIS, silently and completely.
  //
  // The WhatsApp connector reads the desktop app's LOCAL store, and that store
  // only syncs while WhatsApp is running. Nobody leaves it running, so the
  // rows simply stop being recent — with nothing to point at, because the
  // connector keeps succeeding and keeps reading the same old messages.
  // Measured on the owner's Mac before this shipped: the newest iMessage row
  // was 3 hours old and the newest WhatsApp row was 1,805 hours old.
  //
  // The agent opens WhatsApp hidden and in the background every four hours
  // (`open -gj`), which is enough for it to sync. It is separate from
  // agentsInOrder because it is CONDITIONAL: an agent that launches an app
  // nobody installed would fail every four hours and log it forever.
  private static let whatsappAgent = "com.hazlie.whatsapp-keepalive"
  private static let whatsappBundleId = "net.whatsapp.WhatsApp"

  /// Remove a connectors agent left behind by an older install. Without this it
  /// keeps running under launchd — responsible for itself, needing its own FDA,
  /// and racing the app's child for the same cursors and caches.
  static func retireConnectorsAgent() {
    let label = "com.hazlie.connectors"
    let plist = launchAgents.appendingPathComponent("\(label).plist")
    guard fm.fileExists(atPath: plist.path) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["bootout", "gui/\(getuid())/\(label)"]
    try? p.run()
    p.waitUntilExit()
    try? fm.removeItem(at: plist)
    NSLog("Intaglio Labs: retired the connectors launchd agent; it runs as a child now")
  }
  // The llama plist hard-codes Homebrew's binary path; provision points it at
  // the stable copy instead.
  private static let brewLlama = "/opt/homebrew/bin/llama-server"

  // Call once at launch. Runs off the main thread — copying node and booting
  // launchd agents should not block the UI coming up.
  /// Install the WhatsApp keepalive. Idempotent, and called on EVERY launch.
  ///
  /// Separate from provision() for the reason spelled out on the llama runtime
  /// below: provision() no-ops the moment a machine is set up, so anything the
  /// bundle gains LATER never reaches an existing install. This agent is exactly
  /// that case — it did not exist when this Mac was provisioned, and putting it
  /// inside provision() would have shipped a fix that only new installs got.
  static func ensureWhatsAppKeepalive() {
    DispatchQueue.global(qos: .utility).async {
      // Gated on the app, not the connector: the agent's only job is to launch
      // WhatsApp, so WhatsApp's absence is what makes it pointless. Without the
      // gate it would fail every four hours and log it forever.
      guard NSWorkspace.shared
        .urlForApplication(withBundleIdentifier: whatsappBundleId) != nil else { return }
      let plist = launchAgents.appendingPathComponent("\(whatsappAgent).plist")
      guard !fm.fileExists(atPath: plist.path) else { return }
      guard fm.fileExists(
        atPath: backend.appendingPathComponent("agents/\(whatsappAgent).plist").path
      ) else { return }
      installAgent(whatsappAgent)
      NSLog("Intaglio Labs: installed the WhatsApp keepalive")
    }
  }

  static func ensureBackend() {
    DispatchQueue.global(qos: .utility).async {
      let connectPlist = launchAgents.appendingPathComponent("com.hazlie.connect.plist")
      guard !fm.fileExists(atPath: connectPlist.path) else {
        return // already provisioned (owner's setup or a previous run)
      }
      guard fm.fileExists(atPath: backend.appendingPathComponent("connect/server.mjs").path) else {
        NSLog("Intaglio Labs: no bundled backend — a dev build without it, skipping provision")
        return
      }
      do { try provision() }
      catch { NSLog("Intaglio Labs: provisioning failed: \(error)") }
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
    for name in ["hermes-token.txt", "llama-api-key.txt"] {
      let file = hazlie.appendingPathComponent("secrets/\(name)")
      guard !fm.fileExists(atPath: file.path) else { continue }
      var bytes = [UInt8](repeating: 0, count: 32)
      _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
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
      if label == "com.hazlie.llama-server" && !fm.fileExists(atPath: modelLink.path) {
        NSLog("Intaglio Labs: no model yet — skipping the llama agent until one is chosen")
        continue
      }
      installAgent(label)
      if label == "com.hazlie.hermes" { waitForHermes() }
    }
    NSLog("Intaglio Labs: provisioned backend from the app bundle")
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
