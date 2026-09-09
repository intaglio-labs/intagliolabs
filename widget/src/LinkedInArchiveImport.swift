import AppKit
import UniformTypeIdentifiers

enum LinkedInArchiveImport {
  private static let maximumFileBytes: UInt64 = 500 * 1024 * 1024
  private static let canonicalNames: [String: String] = [
    "connections.csv": "Connections.csv",
    "messages.csv": "messages.csv",
  ]

  static func present(completion: @escaping ([String: Any]) -> Void) {
    let panel = NSOpenPanel()
    panel.title = "Import LinkedIn history"
    panel.message = "Choose the LinkedIn ZIP, or Connections.csv and messages.csv."
    panel.prompt = "Import"
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.zip, .commaSeparatedText]
    panel.begin { response in
      guard response == .OK else {
        completion(["state": "cancelled"])
        return
      }
      let urls = panel.urls
      DispatchQueue.global(qos: .userInitiated).async {
        let result: [String: Any]
        do {
          let imported = try importFiles(urls)
          result = ["state": "ok", "imported": imported]
        } catch let error as ImportError {
          result = ["state": "error", "error": error.message]
        } catch let error {
          result = ["state": "error", "error": "Could not import that archive: \(error.localizedDescription)"]
        }
        DispatchQueue.main.async { completion(result) }
      }
    }
  }

  private struct ImportError: Error {
    let message: String
  }

  private static func importFiles(_ urls: [URL]) throws -> [String] {
    guard !urls.isEmpty else { throw ImportError(message: "Choose a LinkedIn ZIP or CSV file.") }
    let manager = FileManager.default
    let home = manager.homeDirectoryForCurrentUser
    let destination = home
      .appendingPathComponent(".hazlie", isDirectory: true)
      .appendingPathComponent("imports", isDirectory: true)
      .appendingPathComponent("linkedin", isDirectory: true)
    try manager.createDirectory(
      at: destination,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)

    var imported = Set<String>()
    for url in urls {
      switch url.pathExtension.lowercased() {
      case "csv":
        guard let canonical = canonicalNames[url.lastPathComponent.lowercased()] else {
          throw ImportError(message: "Choose only Connections.csv or messages.csv.")
        }
        try installDirect(url, as: canonical, in: destination)
        imported.insert(canonical)
      case "zip":
        for canonical in try installFromZip(url, in: destination) {
          imported.insert(canonical)
        }
      default:
        throw ImportError(message: "Choose a LinkedIn ZIP or CSV file.")
      }
    }
    guard !imported.isEmpty else {
      throw ImportError(message: "That archive did not contain Connections.csv or messages.csv.")
    }
    return imported.sorted()
  }

  private static func installDirect(_ source: URL, as name: String, in destination: URL) throws {
    let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0, UInt64(size) <= maximumFileBytes else {
      throw ImportError(message: "That CSV is empty or too large to import safely.")
    }
    let temporary = destination.appendingPathComponent(".linkedin-import-\(UUID().uuidString)")
    do {
      try FileManager.default.copyItem(at: source, to: temporary)
      try finishInstall(temporary, as: name, in: destination)
    } catch let error {
      try? FileManager.default.removeItem(at: temporary)
      throw error
    }
  }

  static func installFromZip(
    _ archive: URL,
    in destination: URL,
    maximumBytes: UInt64 = maximumFileBytes
  ) throws -> [String] {
    let listing = try processOutput("/usr/bin/unzip", arguments: ["-Z1", archive.path])
    guard listing.count <= 1_000_000 else {
      throw ImportError(message: "That ZIP contains too many entries to inspect safely.")
    }
    let entries = String(decoding: listing, as: UTF8.self)
      .split(whereSeparator: \.isNewline)
      .map(String.init)
    guard entries.count <= 20_000 else {
      throw ImportError(message: "That ZIP contains too many entries to inspect safely.")
    }

    var selected: [String: String] = [:]
    for entry in entries {
      let parts = entry.split(separator: "/", omittingEmptySubsequences: false)
      guard !entry.hasPrefix("/"), !parts.contains("..") else { continue }
      let leaf = String(parts.last ?? "").lowercased()
      if let canonical = canonicalNames[leaf], selected[canonical] == nil {
        selected[canonical] = entry
      }
    }
    guard !selected.isEmpty else {
      throw ImportError(message: "That ZIP did not contain Connections.csv or messages.csv.")
    }

    var imported: [String] = []
    for canonical in selected.keys.sorted() {
      guard let entry = selected[canonical] else { continue }
      let temporary = destination.appendingPathComponent(".linkedin-import-\(UUID().uuidString)")
      FileManager.default.createFile(
        atPath: temporary.path,
        contents: nil,
        attributes: [.posixPermissions: 0o600]
      )
      do {
        let output = try FileHandle(forWritingTo: temporary)
        defer { try? output.close() }
        try runProcessLimited(
          "/usr/bin/unzip",
          arguments: ["-p", archive.path, entry],
          output: output,
          maximumBytes: maximumBytes
        )
        let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, UInt64(size) <= maximumBytes else {
          throw ImportError(message: "A LinkedIn CSV in that ZIP is empty or too large to import safely.")
        }
        try finishInstall(temporary, as: canonical, in: destination)
        imported.append(canonical)
      } catch let error {
        try? FileManager.default.removeItem(at: temporary)
        throw error
      }
    }
    return imported
  }

  private static func finishInstall(_ temporary: URL, as name: String, in destination: URL) throws {
    let manager = FileManager.default
    let target = destination.appendingPathComponent(name)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
    if manager.fileExists(atPath: target.path) {
      _ = try manager.replaceItemAt(target, withItemAt: temporary)
    } else {
      try manager.moveItem(at: temporary, to: target)
    }
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
  }

  private static func processOutput(_ executable: String, arguments: [String]) throws -> Data {
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw ImportError(message: "Could not read that ZIP file.")
    }
    return output
  }

  private static func runProcessLimited(
    _ executable: String,
    arguments: [String],
    output: FileHandle,
    maximumBytes: UInt64
  ) throws {
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try process.run()
    var written: UInt64 = 0
    do {
      while true {
        let chunk = try pipe.fileHandleForReading.read(upToCount: 64 * 1024) ?? Data()
        if chunk.isEmpty { break }
        let count = UInt64(chunk.count)
        guard written <= maximumBytes, count <= maximumBytes - written else {
          process.terminate()
          process.waitUntilExit()
          throw ImportError(message: "A LinkedIn CSV in that ZIP is too large to import safely.")
        }
        try output.write(contentsOf: chunk)
        written += count
      }
    } catch let error {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      throw error
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw ImportError(message: "Could not extract the LinkedIn CSV files.")
    }
  }
}
