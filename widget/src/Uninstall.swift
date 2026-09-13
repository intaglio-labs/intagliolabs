import AppKit
import Foundation

// TURNING IT OFF, FROM INSIDE THE APP.
//
// widget/uninstall.sh has done this from a terminal since the beginning, and a
// shell script in a repo is not a thing the person whose Mac this is will ever
// find: the app is LSUIElement, so there is no menu bar, no status item and no
// ⌘Q, and the launch agents bring the services back at every login. On somebody
// else's Mac that is the worst state this app can be in — it cannot be stopped
// by the person running it.
//
// So the steps live here too, in Swift, behind the settings row. THE SAME STEPS
// THE SCRIPT TAKES, with one deliberate difference:
//
//   the script's third step deletes ~/.hazlie. THIS DOES NOT, ever.
//
// That is the irreversible one — the database, the secrets, the models, and no
// backup exists anywhere by design — and it is the one step the settings row
// must not take on a single press. The row says the folder was left; somebody
// who wants it gone deletes a folder, which is a thing they can do themselves
// and undo by not doing it.
enum Uninstall {
  private static let fm = FileManager.default
  private static var launchAgents: URL {
    fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
  }
  /// Where ~/.hazlie actually is for this process, so the alert names the path
  /// being left rather than a guess. HAZLIE_HOME is honoured by the script too.
  static var dataHome: String {
    ProcessInfo.processInfo.environment["HAZLIE_HOME"]
      ?? fm.homeDirectoryForCurrentUser.appendingPathComponent(".hazlie").path
  }

  /// BOTH NAMESPACES, exactly as the script does. An install that predates the
  /// 2026-08-25 com.hazlie.* -> io.intaglio.* rename has agents under the old
  /// label, and an uninstall that only knew today's namespace would leave them
  /// running under launchd with nothing left to point at.
  private static let labelPrefixes = ["io.intaglio.", "com.hazlie."]

  /// Every agent of ours launchd knows about: the plists on disk, plus anything
  /// currently loaded. An agent can be loaded with no plist here (a bootstrap
  /// from a repo path), and one of those left running is the failure this
  /// whole function exists to prevent.
  private static func agentLabels() -> [String] {
    var labels: [String] = []
    let names = (try? fm.contentsOfDirectory(atPath: launchAgents.path)) ?? []
    for name in names where name.hasSuffix(".plist") {
      let label = String(name.dropLast(".plist".count))
      if labelPrefixes.contains(where: label.hasPrefix) { labels.append(label) }
    }
    for label in loadedLabels() where !labels.contains(label) { labels.append(label) }
    return labels
  }

  private static func loadedLabels() -> [String] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["list"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return [] }
    // Read BEFORE waiting. `launchctl list` prints every job on this Mac, which
    // is more than a pipe buffer holds — waiting first deadlocks on a full pipe.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
      .split(separator: "\n")
      .compactMap { line in
        let label = line.split(separator: "\t").last.map(String.init) ?? ""
        return labelPrefixes.contains(where: label.hasPrefix) ? label : nil
      }
  }

  /// Both names, and both places. build.sh installs "/Applications/Intaglio
  /// Labs.app"; "Hazlie.app" is a pre-rename install. The self-move can also
  /// leave a copy behind and records where — taken only when it names one of
  /// our own bundles, so a corrupted default can never aim a delete elsewhere.
  private static func appBundles() -> [String] {
    let home = fm.homeDirectoryForCurrentUser.path
    var paths = [
      "\(home)/Applications/Intaglio Labs.app", "/Applications/Intaglio Labs.app",
      "\(home)/Applications/Hazlie.app", "/Applications/Hazlie.app",
    ]
    if let stale = UserDefaults.standard.string(forKey: "HazlieStaleCopyPath"),
       stale.hasSuffix("/Intaglio Labs.app") || stale.hasSuffix("/Hazlie.app") {
      paths.append(stale)
    }
    // The bundle we are running from, wherever it is — a download run straight
    // out of ~/Downloads is the ordinary first-launch state and would otherwise
    // survive its own uninstall. ALWAYS LAST, and moved to the end even when it
    // is one of the four above: deleting the bundle whose code is still being
    // paged in is the step most likely to end the process early, so everything
    // else is already done by the time it runs.
    let running = Bundle.main.bundleURL.path
    var seen = Set<String>()
    var found = paths.filter { $0 != running && fm.fileExists(atPath: $0) && seen.insert($0).inserted }
    if running.hasSuffix(".app"), fm.fileExists(atPath: running) { found.append(running) }
    return found
  }

  /// What the alert says, built from what is actually on this Mac. A confirm
  /// dialog that lists steps it is not going to take is how a destructive
  /// action loses the owner's trust the first time they read it carefully.
  static func plan() -> (services: [String], apps: [String]) {
    (agentLabels().sorted(), appBundles())
  }

  /// The one modal in the app. Cancel is the default button: this deletes
  /// things, and the safe answer is the one the return key gives.
  /// Main thread only — every caller is a bridge message, which arrives there.
  static func confirm(services: [String], apps: [String]) -> Bool {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Remove Intaglio Labs from this Mac?"
    var body = ""
    body += services.isEmpty
      ? "No background services are installed.\n"
      : "Stops and removes \(services.count) background service\(services.count == 1 ? "" : "s"): "
        + services.joined(separator: ", ") + ".\n"
    body += apps.isEmpty
      ? "No app to delete — this copy is not where it usually lives.\n"
      : "Deletes the app: " + apps.joined(separator: ", ") + ".\n"
    body += "\nLeaves everything it has read where it is, in \(dataHome). "
    body += "Nothing in there is sent anywhere; delete that folder yourself if you want it gone.\n"
    body += "\nmacOS will not let an app revoke its own permissions, so the "
    body += "Full Disk Access and Automation rows stay in System Settings until you remove them."
    alert.informativeText = body
    alert.addButton(withTitle: "Cancel")
    let remove = alert.addButton(withTitle: "Remove")
    remove.hasDestructiveAction = true
    // The widget is a nonactivating panel, so an alert raised from it can open
    // behind whatever is in front. Ask for the app first.
    NSApp.activate(ignoringOtherApps: true)
    return alert.runModal() == .alertSecondButtonReturn
  }

  struct Outcome {
    var services: [String] = []
    var apps: [String] = []
    var failures: [String] = []
    var dataKept: String = Uninstall.dataHome
  }

  /// Do it. Returns what happened rather than logging it and hoping: the page
  /// only quits the app when nothing failed, so a half-uninstall stays on
  /// screen with its reason instead of vanishing with the window.
  ///
  /// NEVER ON THE MAIN THREAD. Every step here is a `launchctl` invocation with
  /// a `waitUntilExit`, plus a bounded wait on the reader; with several agents
  /// and a busy launchd that is seconds of a frozen window with nothing on
  /// screen saying why. `progress` is called as each step lands so the row the
  /// owner pressed can narrate it.
  static func run(progress: @escaping (String) -> Void = { _ in }) -> Outcome {
    var out = Outcome()

    // 1. THE READER FIRST, AND ALL THE WAY DOWN. It is this app's own child,
    //    running from the bundle that is about to be deleted, so it has to be
    //    gone before step 3 rather than merely signalled.
    progress("stopping the reader…")
    if !Connectors.shared.stopAndWait() {
      out.failures.append("the reader would not stop; nothing else was removed")
      // The app is still up and the owner may try again, so the latch stop()
      // set has to come off or every later attempt refuses silently.
      Connectors.shared.allowRestart()
      return out
    }

    // 2. The launch agents. This is the step whose failure the header calls the
    //    thing this function exists to prevent, so it is CHECKED rather than
    //    fired and hoped for.
    let labels = agentLabels().sorted()
    for (index, label) in labels.enumerated() {
      progress("stopping \(label) (\(index + 1) of \(labels.count))…")
      let status = bootout(label)
      // A job that was not loaded is not a failure: `bootout` answers non-zero
      // for "no such process" too, and the plist is what brings it back at
      // login. Ask launchd what is true now instead of reading the code.
      let stillLoaded = loadedLabels().contains(label)
      if stillLoaded {
        out.failures.append("\(label) is still running (launchctl bootout said \(status))")
        continue
      }
      let plist = launchAgents.appendingPathComponent("\(label).plist")
      if fm.fileExists(atPath: plist.path) {
        do { try fm.removeItem(at: plist) } catch {
          out.failures.append("\(label) was stopped but its plist stayed: \(error.localizedDescription)")
          continue
        }
      }
      out.services.append(label)
      NSLog("Intaglio Labs: uninstall removed the \(label) agent")
    }

    // 3. The app. LAST, and only once the two above are settled: a bundle
    //    deleted while an agent is still running leaves launchd pointing at
    //    nothing, which is worse than either failure on its own.
    if out.failures.isEmpty {
      for path in appBundles() {
        progress("deleting \(URL(fileURLWithPath: path).lastPathComponent)…")
        do {
          try fm.removeItem(atPath: path)
          out.apps.append(path)
          NSLog("Intaglio Labs: uninstall removed \(path)")
        } catch {
          out.failures.append("could not delete \(path): \(error.localizedDescription)")
        }
      }
    } else {
      out.failures.append("the app itself was left in place because of the above")
    }

    // A PARTIAL UNINSTALL HAS TO BE A WORKING INSTALL. The app does not quit on
    // a failure, so it is about to go on running with its reader stopped and
    // its latch set — a state in which "start it" reports success for ever and
    // nothing reads. Whatever else is half-done, this much is put back.
    if !out.failures.isEmpty {
      Connectors.shared.allowRestart()
      Connectors.shared.start(bypassingThrottle: true)
    }
    return out
  }

  /// `launchctl bootout` for one label, returning its exit status. The status
  /// alone does not decide anything — see the caller, which asks launchd what
  /// is still loaded — but it is what the owner is shown when a job survives.
  private static func bootout(_ label: String) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["bootout", "gui/\(getuid())/\(label)"]
    p.standardError = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
  }
}
