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

/// WHY the answer is `allOff`, when it is. The same three words node's loader
/// uses (connectors/lib/features.mjs), because the shelf and the daemon both
/// have to say the same thing about the same broken install.
///
/// A missing or invalid registry switches off the card's own connectors too —
/// imessage, mail, calendar, contacts — which is a total product outage, and
/// until this existed it was indistinguishable at every surface from an install
/// where the owner had simply connected nothing.
enum RegistryState: String {
  case ok
  case missing
  case invalid
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
  private static var cachedState: RegistryState?

  /// The effective set for this process. Read once; the registry ships in the
  /// bundle and the override is a developer affordance, so re-reading it on
  /// every decision would buy nothing and would put a file read on the path of
  /// every panel open.
  static var current: FeatureSet {
    lock.lock()
    defer { lock.unlock() }
    if let cached { return cached }
    let (value, state) = loadWithState()
    cached = value
    cachedState = state
    return value
  }

  /// 'ok', 'missing' or 'invalid' for the set `current` returned. Read through
  /// the same cache, so asking costs nothing and cannot disagree with it.
  static var registryState: RegistryState {
    _ = current
    lock.lock()
    defer { lock.unlock() }
    return cachedState ?? .invalid
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

  /// ~~`peopleButtonOpensPeopleDirectly`: with the timeline off, route the
  /// People button straight to the "Same person?" review, which was a KEEP and
  /// had no other door.~~ Gone with the surface review (2026-09-13): the review
  /// IS the duplicate-pair window the owner asked to take off the bar, so the
  /// button follows `timeline` in both halves now — hidden in widget.js before
  /// the first paint, and `openMonths()` returning early in main.swift. The
  /// pages and their bridge grants stay, unreachable rather than deleted; a
  /// later `identity` flag is what would separate find-pairs from the timeline.
  /// `shouldBuildTimelinePanel` is the one gate both halves read.

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
    loadWithState(registry: registry, override: override).0
  }

  /// The set AND why. `missing` is a bundle that does not carry the file at
  /// all; `invalid` is one that carries an unreadable one. Both answer allOff —
  /// "the file that says what is on is unreadable" must never resolve to
  /// "everything is on" — and the owner is owed different words for each.
  static func loadWithState(registry: URL? = bundledRegistry,
                            override: URL? = ownerOverride) -> (FeatureSet, RegistryState) {
    guard let registry, let data = try? Data(contentsOf: registry) else {
      NSLog("Intaglio Labs: no feature registry in this bundle — everything is off")
      return (.allOff, .missing)
    }
    guard let base = parseRegistry(data) else {
      NSLog("Intaglio Labs: the feature registry is unreadable — everything is off")
      return (.allOff, .invalid)
    }
    guard let override, let overrideData = try? Data(contentsOf: override) else { return (base, .ok) }
    guard let object = try? JSONSerialization.jsonObject(with: overrideData) as? [String: Any] else {
      NSLog("Intaglio Labs: features override is not a JSON object — ignored")
      return (base, .ok)
    }
    do {
      return (try merge(base, object), .ok)
    } catch {
      // DISCARD THE OVERRIDE, KEEP THE REGISTRY. See the header.
      NSLog("Intaglio Labs: features override ignored: \(error.localizedDescription)")
      return (base, .ok)
    }
  }

  static func parseRegistry(_ data: Data) -> FeatureSet? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          jsonNumber(object["version"])?.intValue == 1,
          let features = object["features"] as? [String: Any] else { return nil }
    // Start from allOff, so a key the shipped file forgot is OFF rather than
    // inheriting whatever a struct default happened to be.
    return try? merge(.allOff, features)
  }

  /// A JSON `true`/`false`, AND NOT A NUMBER THAT LOOKS LIKE ONE.
  ///
  /// JSONSerialization hands back NSNumber for both `true` and `1`, and
  /// `as? Bool` accepts either — so `{"chat": 1}` switched chat ON in the app
  /// while node's loader (which requires `typeof value === 'boolean'`) threw the
  /// WHOLE override away and reported chat off. One file, two answers, and the
  /// daemon and the app acting on different registries. CFBooleanGetTypeID is
  /// the one check that tells the two apart: JSON booleans arrive as
  /// kCFBoolean{True,False}, JSON numbers as __NSCFNumber.
  static func jsonBool(_ value: Any) -> Bool? {
    guard CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return nil }
    return (value as? NSNumber)?.boolValue
  }

  /// A JSON NUMBER, AND NOT A BOOLEAN WEARING ONE'S CLOTHES. The same NSNumber
  /// ambiguity as jsonBool, one field further up and pointing the other way:
  /// `as? Int` on the NSNumber that JSON `true` bridges to yields 1, so
  /// `{"version": true}` passed this app's version check while node's loader
  /// (`raw?.version !== 1`) refused the whole file. A registry shipped that way
  /// meant the daemon at ALL_OFF, scheduling nothing and painting the shelf's
  /// red line, while the app ran the full feature set — chat panel and all. Two
  /// processes, one file, opposite answers, which is the exact failure jsonBool
  /// exists to prevent one field below.
  static func jsonNumber(_ value: Any?) -> NSNumber? {
    guard let value, CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID() else { return nil }
    return value as? NSNumber
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
          } else if let flag = jsonBool(state) {
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
      guard let flag = jsonBool(value) else {
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
