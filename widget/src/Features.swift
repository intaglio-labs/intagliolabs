import Foundation

// THE FEATURE REGISTRY, app side. The full design is the header of
// connectors/lib/features.mjs and the short version is ops/FEATURES.md; this
// file is the same contract for Swift and must not drift from either.
//
// One sentence of it, because it is the part that bites: a missing or
// unreadable registry resolves to `allOff`, never to "everything on". The app
// ships the file inside its own bundle (widget/build.sh copies ops/features.json
// to backend/ops/features.json), so an unreadable one means the bundle is
// broken, and a broken bundle must not provision a Matrix homeserver.
//
// The owner override, ~/.hazlie/features.json, is partial and merged over the
// shipped file. An unknown key there is logged and the whole override is
// DISCARDED — the shipped registry still applies. A typo in a developer's local
// file must not brick the app.

/// A connector's three states. `optional` is not a boolean in disguise: it
/// means offered on the connections page but not auto-scheduled until the owner
/// connects it.
enum ConnectorState: Equatable {
  case on
  case off
  case optional

  init(_ value: Bool) { self = value ? .on : .off }
}

struct FeatureSet: Equatable {
  var chat = false
  var voice = false
  var bridges = false
  var timeline = false
  var constellation = false
  var distiller = false
  var frontierHandoff = false
  var search = false
  var connectors: [String: ConnectorState] = [:]

  /// The order features are logged in; also the closed set of known names.
  static let names = ["chat", "voice", "bridges", "timeline", "constellation",
                      "distiller", "frontierHandoff", "search"]
  static let connectorNames = ["imessage", "mail", "calendar", "contacts", "linkedin",
                               "whatsapp", "granola",
                               "notes", "files", "photos", "notion", "oura", "health"]

  /// Everything off, including the card's own connectors. The static default
  /// and the answer to any unreadable registry.
  static let allOff = FeatureSet(
    connectors: Dictionary(uniqueKeysWithValues: connectorNames.map { ($0, ConnectorState.off) }))

  func connector(_ name: String) -> ConnectorState { connectors[name] ?? .off }

  subscript(name: String) -> Bool {
    switch name {
    case "chat": return chat
    case "voice": return voice
    case "bridges": return bridges
    case "timeline": return timeline
    case "constellation": return constellation
    case "distiller": return distiller
    case "frontierHandoff": return frontierHandoff
    case "search": return search
    default: return false
    }
  }

  /// Names only. Never the file, never anything a reader could mistake for
  /// owner data — the same rule the node logger holds to.
  var enabledNames: [String] {
    FeatureSet.names.filter { self[$0] }
      + FeatureSet.connectorNames.filter { connector($0) == .on }.map { "connector:\($0)" }
      + FeatureSet.connectorNames.filter { connector($0) == .optional }.map { "connector:\($0)?" }
  }
}

enum Features {
  private static let lock = NSLock()
  private static var cached: FeatureSet?

  /// The effective set for this process. Read once; the registry ships in the
  /// bundle and the override is a developer affordance, so re-reading it on
  /// every decision would buy nothing and would put a file read on the path of
  /// every panel open.
  static var current: FeatureSet {
    lock.lock()
    defer { lock.unlock() }
    if let cached { return cached }
    let value = load()
    cached = value
    return value
  }

  static func on(_ name: String) -> Bool { current[name] }
  static func connector(_ name: String) -> ConnectorState { current.connector(name) }

  /// Log what is ON, once, at launch. A build that turns something back on
  /// should say so in the same place a reader looks for why it did.
  static func logEnabled() {
    let names = current.enabledNames
    NSLog("Intaglio Labs: features on — \(names.isEmpty ? "(none)" : names.joined(separator: ", "))")
  }

  // MARK: decisions
  //
  // Pure functions of a FeatureSet, so the provisioning decisions can be read
  // (and tested) without standing up a Mac. Each one answers a question some
  // caller in Provision/main was previously answering by not asking.

  /// Warm the Matrix/mautrix runtime at launch? ~305 MB of binaries and a
  /// Synapse build, for sources the card does not read.
  static func shouldPrefetchBridgeRuntime(_ f: FeatureSet) -> Bool { f.bridges }

  /// Run setup-bridges-native.sh, which is what installs io.intaglio.bridges.
  static func shouldEnsureBridgeRuntime(_ f: FeatureSet) -> Bool { f.bridges }

  /// Retire an io.intaglio.bridges agent a previous install left running.
  /// Skipping the install is not enough on an upgrade: launchd already has the
  /// job, and RunAtLoad + KeepAlive means it comes back every login.
  static func shouldRetireBridgesAgent(_ f: FeatureSet) -> Bool { !f.bridges }

  /// Clone the ~495 MB voice model tree out of the bundle into ~/.hazlie.
  /// (Taking the models OUT of the bundle is stage 2; this only stops the copy.)
  static func shouldCloneVoiceModels(_ f: FeatureSet) -> Bool { f.voice }

  /// Build the hidden ear webview inside the widget window.
  static func shouldBuildEarWebView(_ f: FeatureSet) -> Bool { f.voice }

  /// Build the chat panel and its webview.
  static func shouldBuildChatPanel(_ f: FeatureSet) -> Bool { f.chat }

  /// Build the timeline (people-months) panel.
  static func shouldBuildTimelinePanel(_ f: FeatureSet) -> Bool { f.timeline }

  /// With the timeline off, the gear row's People button has nowhere to go —
  /// and the People popup ("Same person?" review) is a KEEP, reachable today
  /// only through the timeline's own openPeople. So the button routes straight
  /// to People instead of opening nothing. Native-side routing on purpose: the
  /// page keeps posting `openMonths` and no bridge capability changes.
  static func peopleButtonOpensPeopleDirectly(_ f: FeatureSet) -> Bool { !f.timeline }

  /// Run a distillation pass. ANDed with the existing ~/.hazlie/distill.enabled
  /// marker, never replacing it: the marker is the "no in-app way to review
  /// claims yet" gate and it has its own reason to exist.
  static func shouldDistill(_ f: FeatureSet, markerPresent: Bool) -> Bool {
    f.distiller && markerPresent
  }

  // MARK: loading

  private static var bundledRegistry: URL? {
    (Bundle.main.resourceURL ?? Bundle.main.bundleURL)
      .appendingPathComponent("backend/ops/features.json")
  }

  private static var ownerOverride: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/features.json")
  }

  static func load(registry: URL? = bundledRegistry, override: URL? = ownerOverride) -> FeatureSet {
    guard let registry,
          let data = try? Data(contentsOf: registry),
          let base = parseRegistry(data) else {
      NSLog("Intaglio Labs: no readable feature registry — everything is off")
      return .allOff
    }
    guard let override, let overrideData = try? Data(contentsOf: override) else { return base }
    guard let object = try? JSONSerialization.jsonObject(with: overrideData) as? [String: Any] else {
      NSLog("Intaglio Labs: features override is not a JSON object — ignored")
      return base
    }
    do {
      return try merge(base, object)
    } catch {
      // DISCARD THE OVERRIDE, KEEP THE REGISTRY. See the header.
      NSLog("Intaglio Labs: features override ignored: \(error.localizedDescription)")
      return base
    }
  }

  static func parseRegistry(_ data: Data) -> FeatureSet? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (object["version"] as? Int) == 1,
          let features = object["features"] as? [String: Any] else { return nil }
    // Start from allOff, so a key the shipped file forgot is OFF rather than
    // inheriting whatever a struct default happened to be.
    return try? merge(.allOff, features)
  }

  private struct Rejected: LocalizedError {
    let reason: String
    var errorDescription: String? { reason }
  }

  static func merge(_ base: FeatureSet, _ object: [String: Any]) throws -> FeatureSet {
    var merged = base
    for (key, value) in object {
      if key == "version" { continue } // informational; an override is partial by design
      if key == "connectors" {
        guard let table = value as? [String: Any] else {
          throw Rejected(reason: "\"connectors\" must be an object")
        }
        for (name, state) in table {
          guard FeatureSet.connectorNames.contains(name) else {
            throw Rejected(reason: "unknown connector \"\(name)\"")
          }
          // NSNumber bridges JSON true/false, so check the string case first and
          // the boolean second; `as? Bool` on the string would simply fail, but
          // saying the order out loud is cheaper than rediscovering it.
          if let text = state as? String {
            guard text == "optional" else {
              throw Rejected(reason: "connector \"\(name)\" must be true, false or \"optional\"")
            }
            merged.connectors[name] = .optional
          } else if let flag = state as? Bool {
            merged.connectors[name] = ConnectorState(flag)
          } else {
            throw Rejected(reason: "connector \"\(name)\" must be true, false or \"optional\"")
          }
        }
        continue
      }
      guard FeatureSet.names.contains(key) else {
        throw Rejected(reason: "unknown feature \"\(key)\"")
      }
      guard let flag = value as? Bool else {
        throw Rejected(reason: "feature \"\(key)\" must be true or false")
      }
      switch key {
      case "chat": merged.chat = flag
      case "voice": merged.voice = flag
      case "bridges": merged.bridges = flag
      case "timeline": merged.timeline = flag
      case "constellation": merged.constellation = flag
      case "distiller": merged.distiller = flag
      case "frontierHandoff": merged.frontierHandoff = flag
      case "search": merged.search = flag
      default: break // unreachable: names is checked above
      }
    }
    return merged
  }
}
