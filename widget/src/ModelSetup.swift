// Downloading the answer model, and turning it on.
//
// The .gguf is the one asset this app fetches rather than ships. build.sh says
// why: the runtime is 30 MB and the voice models cannot be produced on a user's
// machine at all, but the weights are 2.5-4.7 GB of a 5.3 GB bundle, they come
// as ONE file from a host already declared in ops/EGRESS.json, and they are the
// only piece with a real choice in it — 4B and 8B suit different Macs.
//
// THE NUMBERS HERE MIRROR ops/setup-llm.sh AND MUST KEEP MIRRORING IT. Same
// repos, same filenames, same byte counts, same sha256s, same
// models/model.gguf symlink, same launchd label. The two paths provision the
// same machine — a person can run either — so a difference between them is a
// machine that half-works. modelTiersMatchSetupScript() in
// widget/test/model-tiers.test.mjs reads both and fails if they drift.
//
// NOTHING IS TRUSTED UNTIL IT HASHES. A partial or corrupted 4.7 GB file is
// indistinguishable from a good one until you check, and the failure it causes
// (llama-server refusing to load, or loading garbage) surfaces far from here.
// The download lands in a temp name and is only put in place after the digest
// matches the constant below.
import Foundation
import CryptoKit

struct ModelTier {
  let id: String            // "4b" | "8b"
  let label: String
  let detail: String
  let file: String
  let repo: String
  let bytes: Int64
  let sha256: String
  var url: URL { URL(string: "https://huggingface.co/\(repo)/resolve/main/\(file)")! }
}

enum ModelSetup {
  static let tiers: [ModelTier] = [
    ModelTier(
      id: "4b",
      label: "Smaller",
      detail: "Faster, lighter on memory. Good on 8 GB Macs.",
      file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
      repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
      bytes: 2_497_281_120,
      sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"
    ),
    ModelTier(
      id: "8b",
      label: "Better",
      detail: "Noticeably better answers. Wants 16 GB or more.",
      file: "Qwen3-8B-Q4_K_M.gguf",
      repo: "Qwen/Qwen3-8B-GGUF",
      bytes: 5_027_783_488,
      sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785"
    ),
  ]

  // Same rule as setup-llm.sh: 8B above 8 GiB, 4B at or below it.
  static var recommended: String {
    ProcessInfo.processInfo.physicalMemory > 8 * 1024 * 1024 * 1024 ? "8b" : "4b"
  }

  private static let fm = FileManager.default
  private static var home: URL { fm.homeDirectoryForCurrentUser }
  private static var modelDir: URL { home.appendingPathComponent(".hazlie/models") }

  /// The tier already installed, if any — decided by the symlink's target, so
  /// it agrees with whatever setup-llm.sh last pointed it at.
  static var installed: ModelTier? {
    let link = modelDir.appendingPathComponent("model.gguf")
    guard let dest = try? fm.destinationOfSymbolicLink(atPath: link.path) else {
      // A real file rather than a link: installed, tier unknown. Report the
      // one whose size matches so the UI can say something true.
      guard fm.fileExists(atPath: link.path),
            let size = (try? fm.attributesOfItem(atPath: link.path)[.size]) as? Int64
      else { return nil }
      return tiers.first { $0.bytes == size }
    }
    return tiers.first { $0.file == (dest as NSString).lastPathComponent }
  }

  static var isInstalled: Bool { installed != nil }

  // MARK: download

  private static var task: URLSessionDownloadTask?
  private static var driver: Driver?
  /// Set by cancel(), checked by the work that has no URLSessionTask to cancel.
  private static var cancelled = false
  private static let lock = NSLock()

  static var isDownloading: Bool { task != nil || busy }
  private static var busy = false

  private static var isCancelled: Bool {
    lock.lock(); defer { lock.unlock() }
    return cancelled
  }

  /// CANCEL HAS TO REACH THE WORK THAT IS NOT A DOWNLOAD.
  ///
  /// This used to cancel the URLSessionTask and nothing else, which meant it did
  /// nothing at all on the path that matters most: a file already on disk is
  /// never downloaded, it is HASHED, and hashing several GB takes long enough
  /// that cancel is exactly what a person reaches for. There was no task to
  /// cancel, so the button moved the screen back and the work carried on and
  /// then relinked the model underneath them.
  static func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    task?.cancel()
    task = nil
    driver = nil
  }

  /// Start fetching `tierId`. `progress` fires on the main thread with
  /// (receivedBytes, totalBytes); `done` fires once with nil on success or a
  /// human-readable reason on failure.
  static func download(
    tierId: String,
    progress: @escaping (Int64, Int64) -> Void,
    done: @escaping (String?) -> Void
  ) {
    guard !isDownloading else { done("a download is already running"); return }
    guard let tier = tiers.first(where: { $0.id == tierId }) else { done("unknown model"); return }
    lock.lock(); cancelled = false; lock.unlock()
    busy = true
    do {
      try fm.createDirectory(at: modelDir, withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
    } catch {
      done("could not create the models folder")
      return
    }

    let finish: (String?) -> Void = { reason in
      DispatchQueue.main.async {
        task = nil
        driver = nil
        busy = false
        done(isCancelled ? "cancelled" : reason)
      }
    }

    // ALREADY ON DISK? Don't fetch it again.
    //
    // The weights outlive the symlink: switching tiers and back, re-running
    // onboarding, or having previously used setup-llm.sh all leave a complete
    // file sitting there under its own name. Re-downloading 4.7 GB to arrive at
    // a file already present is the kind of thing a person notices and does not
    // forgive. setup-llm.sh checks size-then-digest for the same reason; this
    // is the same check, and the digest is what makes reuse safe rather than
    // hopeful — a truncated leftover fails it and falls through to the fetch.
    let existing = modelDir.appendingPathComponent(tier.file)
    if let size = (try? fm.attributesOfItem(atPath: existing.path)[.size]) as? Int64,
       size == tier.bytes {
      DispatchQueue.global(qos: .utility).async {
        DispatchQueue.main.async { progress(tier.bytes, tier.bytes) }
        let sum = digest(of: existing)
        guard !isCancelled else { finish("cancelled"); return }
        if sum == tier.sha256 {
          // Relink only; the bytes are already correct and already here.
          do {
            try link(tier)
            finish(nil)
          } catch {
            finish("could not put the model in place")
          }
        } else {
          try? fm.removeItem(at: existing)
          startDownload(tier: tier, progress: progress, finish: finish)
        }
      }
      return
    }
    startDownload(tier: tier, progress: progress, finish: finish)
  }

  private static func startDownload(
    tier: ModelTier,
    progress: @escaping (Int64, Int64) -> Void,
    finish: @escaping (String?) -> Void
  ) {

    let d = Driver(tier: tier, progress: progress, finish: finish)
    driver = d
    let session = URLSession(configuration: .default, delegate: d, delegateQueue: nil)
    let t = session.downloadTask(with: tier.url)
    task = t
    t.resume()
  }

  /// Put a verified file in place: name it after the tier, point model.gguf at
  /// it, and stamp the active model the way setup-llm.sh does so a later run of
  /// that script agrees about what is installed.
  fileprivate static func install(_ tmp: URL, _ tier: ModelTier) throws {
    let dst = modelDir.appendingPathComponent(tier.file)
    if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
    try fm.moveItem(at: tmp, to: dst)
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dst.path)
    try link(tier)
  }

  /// Point model.gguf at this tier and stamp it, the way setup-llm.sh does, so
  /// a later run of that script agrees about what is installed.
  fileprivate static func link(_ tier: ModelTier) throws {
    let link = modelDir.appendingPathComponent("model.gguf")
    if let _ = try? fm.destinationOfSymbolicLink(atPath: link.path) {
      try? fm.removeItem(at: link)
    } else if fm.fileExists(atPath: link.path) {
      try? fm.removeItem(at: link)
    }
    try fm.createSymbolicLink(atPath: link.path, withDestinationPath: tier.file)
    try? tier.file.write(to: modelDir.appendingPathComponent("active-model.txt"),
                         atomically: true, encoding: .utf8)
  }

  /// Streamed so a 4.7 GB file is never held in memory.
  fileprivate static func digest(of url: URL) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try? handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty {
      // Checked per chunk rather than once at the end: hashing 5 GB takes long
      // enough that a cancel arriving halfway through must be felt in seconds.
      if isCancelled { return nil }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private final class Driver: NSObject, URLSessionDownloadDelegate {
    let tier: ModelTier
    let progress: (Int64, Int64) -> Void
    let finish: (String?) -> Void

    init(tier: ModelTier, progress: @escaping (Int64, Int64) -> Void, finish: @escaping (String?) -> Void) {
      self.tier = tier
      self.progress = progress
      self.finish = finish
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
      // The server's Content-Length is advisory; the tier's own byte count is
      // the one we verify against, so report against that when it is known.
      let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : tier.bytes
      DispatchQueue.main.async { self.progress(totalBytesWritten, total) }
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
      // Moved out of the system's temp location IMMEDIATELY — it is deleted the
      // moment this method returns.
      let staged = ModelSetup.modelDir.appendingPathComponent(".\(tier.file).part")
      try? ModelSetup.fm.removeItem(at: staged)
      do {
        try ModelSetup.fm.moveItem(at: location, to: staged)
      } catch {
        finish("could not save the download")
        return
      }

      if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
        try? ModelSetup.fm.removeItem(at: staged)
        finish("the model host answered \(http.statusCode)")
        return
      }

      let size = (try? ModelSetup.fm.attributesOfItem(atPath: staged.path)[.size]) as? Int64 ?? 0
      guard size == tier.bytes else {
        try? ModelSetup.fm.removeItem(at: staged)
        finish("the download was incomplete — check your connection and try again")
        return
      }
      guard ModelSetup.digest(of: staged) == tier.sha256 else {
        try? ModelSetup.fm.removeItem(at: staged)
        finish("the download did not match its checksum and was discarded")
        return
      }
      do {
        try ModelSetup.install(staged, tier)
      } catch {
        try? ModelSetup.fm.removeItem(at: staged)
        finish("could not put the model in place")
        return
      }
      finish(nil)
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard let error else { return } // success already reported above
      if (error as NSError).code == NSURLErrorCancelled { finish("cancelled"); return }
      finish("the download failed — check your connection and try again")
    }
  }
}
