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
    guard file.path.hasPrefix(fence),
          let data = try? Data(contentsOf: file) else {
      dbg("asset MISS: \(path)")
      task.didFailWithError(NSError(
        domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist,
        userInfo: [NSLocalizedDescriptionKey: "no asset at \(path)"]))
      return
    }
    let response = HTTPURLResponse(
      url: url, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": mimeType(for: file.pathExtension),
        "Content-Length": String(data.count),
        "Cache-Control": "no-store",
      ])!
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
