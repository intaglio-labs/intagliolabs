import Foundation

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
  private static let agentsInOrder = ["com.hazlie.hermes", "com.hazlie.llama-server", "com.hazlie.connect", "com.hazlie.connectors"]
  // The llama plist hard-codes Homebrew's binary path; provision points it at
  // the stable copy instead.
  private static let brewLlama = "/opt/homebrew/bin/llama-server"

  // Call once at launch. Runs off the main thread — copying node and booting
  // launchd agents should not block the UI coming up.
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

    // The two 64-hex secrets hermes refuses to start without, 0600, if they
    // aren't already there: the hermes bearer, and the llama API key (hermes
    // reads that key at startup, and the rendered llama plist passes
    // --api-key-file pointing at the same path — with it missing, both
    // agents crash-loop on a fresh Mac). The repo-based setup gets them from
    // ops/setup-llm.sh, which a downloaded app never runs.
    for name in ["hermes-token.txt", "llama-api-key.txt"] {
      let secretFile = hazlie.appendingPathComponent("secrets/\(name)")
      if !fm.fileExists(atPath: secretFile.path) {
        var bytes = [UInt8](repeating: 0, count: 32)
        // Checked: on failure the array would stay all zeros and the file
        // would hold a predictable credential. Abort provisioning instead.
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
          throw NSError(domain: "Provision", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "SecRandomCopyBytes failed generating \(name)"])
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        try token.write(to: secretFile, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: secretFile.path)
      }
    }

    // Render each plist (@HOME@ → home, @REPO@ → the bundle's backend), write
    // it 0644, and bootstrap. Wait for hermes to answer /health before the
    // rest, so connectors don't write into a database still opening.
    for label in agentsInOrder {
      let template = backend.appendingPathComponent("agents/\(label).plist")
      guard var text = try? String(contentsOf: template, encoding: .utf8) else { continue }
      text = text.replacingOccurrences(of: "@HOME@", with: home.path)
      text = text.replacingOccurrences(of: "@REPO@", with: backend.path)
      // The llama plist hard-codes Homebrew's binary; point it at the copy.
      text = text.replacingOccurrences(of: brewLlama, with: hazlie.appendingPathComponent("bin/llama-server").path)
      let dst = launchAgents.appendingPathComponent("\(label).plist")
      try text.write(to: dst, atomically: true, encoding: .utf8)
      try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dst.path)
      bootstrap(dst)
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
    guard let url = URL(string: "http://127.0.0.1:8789/health") else { return }
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
