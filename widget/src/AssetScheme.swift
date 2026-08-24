// hazlie-asset:// — the ear page's origin. Replaces the retired Expo dev
// server for loading the voice stack: page code from the app bundle,
// provisioned artifacts (models, vendor bundles, built workers, baked lines)
// from ~/.hazlie/models/voice. Read-only, path-traversal-guarded, and not a
// socket: WKURLSchemeHandler serves straight from disk, so the egress-zero
// audit is unchanged.
import Foundation
import WebKit

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "hazlie-asset"

  private let bundleRoot: URL
  private let provisionedRoot: URL
  // Root-relative prefixes the ported voice code fetches (unchanged from the
  // frontend, which served them from ui/public/): these come from the
  // provisioned tree; everything else is page code from the bundle.
  private let provisionedPrefixes = ["/models/", "/vendor/", "/workers/", "/voice/"]
  // Chunked delivery state: ids of the tasks still owed bytes. Touched only
  // on the main thread — start/stop run there, and the read queue reaches it
  // inside main.sync — so no lock. A task stop(_:) has withdrawn must never
  // be called into again (WebKit raises), hence the membership checks.
  private var live = Set<ObjectIdentifier>()
  private let readQueue = DispatchQueue(label: "hazlie.asset-read", qos: .userInitiated)
  private static let chunkBytes = 4 * 1024 * 1024

  override init() {
    bundleRoot = Bundle.main.resourceURL!.appendingPathComponent("ui")
    provisionedRoot = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/models/voice")
    super.init()
  }

  private func mimeType(for ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html"
    case "js", "mjs": return "text/javascript"
    case "css": return "text/css"
    case "json": return "application/json"
    case "wasm": return "application/wasm"
    case "svg": return "image/svg+xml"
    default: return "application/octet-stream"
    }
  }

  private func dbg(_ line: String) {
    guard ProcessInfo.processInfo.environment["HAZLIE_DEBUG_ARM"] == "1" else { return }
    let f = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/logs/widget-asset.log")
    let msg = line + "\n"
    if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(msg.data(using: .utf8)!); try? h.close() }
    else { try? msg.write(to: f, atomically: true, encoding: .utf8) }
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    dbg("asset request: \(url.absoluteString)")
    let path = url.path.isEmpty ? "/" : url.path
    let root = provisionedPrefixes.contains(where: { path.hasPrefix($0) })
      ? provisionedRoot : bundleRoot
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    // Never serve outside the chosen root, whatever the path spells.
    //
    // The trailing separator is load-bearing. standardizedFileURL resolves `..`,
    // so ordinary traversal lands outside the root and is refused here -- but a
    // bare hasPrefix also accepts a SIBLING whose name merely starts with the
    // root's: ~/.hazlie/models/voice is a prefix of ~/.hazlie/models/voice-x, so
    // a path that climbs one level and re-enters a similarly-named directory
    // would pass. Comparing against root + "/" makes the check mean containment
    // rather than string prefix.
    let fence = root.standardizedFileURL.path + "/"
    // Opened as a HANDLE rather than read whole (see the chunked delivery
    // below); the directory check is what Data(contentsOf:) used to do for
    // free, since a FileHandle on a directory opens fine and reads nothing.
    var isDir: ObjCBool = false
    guard file.path.hasPrefix(fence),
          FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir),
          !isDir.boolValue,
          let handle = try? FileHandle(forReadingFrom: file) else {
      dbg("asset MISS: \(path)")
      task.didFailWithError(NSError(
        domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist,
        userInfo: [NSLocalizedDescriptionKey: "no asset at \(path)"]))
      return
    }
    let size = (try? handle.seekToEnd()) ?? 0
    try? handle.seek(toOffset: 0)
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": mimeType(for: file.pathExtension),
        "Content-Length": String(size),
        "Cache-Control": "no-store",
      ])!
    task.didReceive(response)
    // The bytes move OFF the main thread, in chunks. start(_:) runs on the
    // main thread and this handler serves the voice model files (up to
    // 325MB); one whole-file Data(contentsOf:) here froze the entire app —
    // widget, chat and settings share this process — for the read, while
    // doubling peak memory. Each chunk hops back to the main thread
    // (WKURLSchemeTask must be driven where start ran); main.sync bounds the
    // buffer to one chunk and paces the read to the delivery.
    let taskId = ObjectIdentifier(task)
    live.insert(taskId)
    readQueue.async {
      var offset: UInt64 = 0
      var withdrawn = false
      // Each read is clamped to the bytes still owed, so a file that grew
      // since the size snapshot (a re-provision rewriting a model under the
      // open handle) can never push WebKit more bytes than the
      // Content-Length above promised.
      while !withdrawn, offset < size,
            let chunk = try? handle.read(
              upToCount: Int(min(UInt64(AssetSchemeHandler.chunkBytes), size - offset))),
            !chunk.isEmpty {
        offset += UInt64(chunk.count)
        DispatchQueue.main.sync {
          if self.live.contains(taskId) { task.didReceive(chunk) } else { withdrawn = true }
        }
      }
      // Grow direction of the changed-mid-read guard: every promised byte
      // was read, yet the file holds more — the delivery is a torn mix of
      // old and new content, so it must not finish as success.
      var grew = false
      if !withdrawn, offset >= size,
         let probe = try? handle.read(upToCount: 1), !probe.isEmpty {
        grew = true
      }
      try? handle.close()
      let delivered = offset
      DispatchQueue.main.sync {
        guard self.live.remove(taskId) != nil else { return }
        if delivered >= size, !grew {
          task.didFinish()
        } else {
          // The promised Content-Length cannot be met honestly: the file
          // shrank (short read), grew past the snapshot, or the disk failed
          // mid-read. Fail rather than hand the page a silently truncated —
          // or torn — model as success.
          task.didFailWithError(NSError(
            domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
            userInfo: [NSLocalizedDescriptionKey: "asset read failed at \(path)"]))
        }
      }
    }
  }

  // Withdraws a task mid-stream (page torn down, fetch aborted); the
  // in-flight read notices on its next chunk and stops.
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    live.remove(ObjectIdentifier(task))
  }
}
