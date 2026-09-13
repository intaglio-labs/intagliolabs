// The bridge: every JS↔native message and every byte of HTTP, in one file.
//
// This file is the egress choke point. ~~The audit for "nothing leaves the
// box" was: the only two URLs this process can reach are the loopback bases
// below.~~ Narrowed 2026-08-31 by the owner's frontier decision; the audit
// now reads: its own URLSession still reaches only the two loopback bases
// below; redirects are refused; the webviews themselves can load only local
// app assets (Windows.swift + each page's CSP). The one explicit handoff out
// is `frontierSend`: after the owner edits and approves a bounded prompt,
// FrontierRunner gives that text on stdin to an installed, official provider
// client. No webview or database gets a provider credential.
import AppKit
import WebKit
import UniformTypeIdentifiers

/// Which page under the connect token the app may open. An ENUM, never a string
/// from JS: connectLink() validates the base (http, loopback, re-read each time
/// because minting a link revokes the last), and this closes the suffix, so no
/// caller can steer the browser at an arbitrary path under a live token.
enum ConnectPath: String {
  case root = ""
  case bridge = "/bridge"
}

protocol BridgeDelegate: AnyObject {
  func openChat()
  func openChat(with utterance: String)
  func takePendingUtterance() -> String
  func takePendingVoiceNote() -> String
  func armVoice()
  func voiceTranscript(_ utterance: String)
  func voiceNote(_ message: String)
  func setOrbTalking(_ talking: Bool)
  func setOrbFace(_ face: String)
  func speakAnswer(_ text: String)
  func openConnections()
  func openPeople()
  func openMonths()
  func openReconnect()
  // Poked whenever a judgment or a panel close may have left the widget
  // orb showing a stale reconnect card -- see relCardChanged in main.swift.
  func relCardChanged()
  // Takes a path and a query since the login window can hand off to
  // /bridge?p=<platform>. Both sides are load-bearing and picking either alone
  // fails to compile — at a CALL SITE rather than here, which is the slow way to
  // find it. This conflict also surfaced by luck: two lines higher and it would
  // have merged clean and broken openReconnect's two callers silently.
  func openConnectRoot(path: ConnectPath, query: [String: String]) -> Bool
  func closeWindow(of webView: WKWebView)
  func dragWindow(of webView: WKWebView)
  func motionAnywayChanged(_ on: Bool)
  func soundsChanged(_ on: Bool)
  func scaleChanged(_ scale: Double, committed: Bool, from webView: WKWebView?)
  func fitPopup(_ webView: WKWebView, contentHeight: Double)
  func widgetSpot() -> [String: Double]
  func chatBarOpenChanged(_ open: Bool)
  func widgetBoundsChanged()
  func spotlightWidget(_ on: Bool)
  func openOnboarding()
  func setupProgress(_ payload: [String: Any])
  /// Drop the onboarding scrim below ordinary windows so a system prompt can be
  /// seen, and put it back afterwards.
  func yieldForPrompt(_ yield: Bool)
  // Like yieldForPrompt, but for System Settings rather than a transient
  // dialog: it also pushes the scrim BEHIND, because Settings is a window the
  // owner works in for a while rather than answers and dismisses.
  func yieldForSettings(_ yield: Bool)
  /// The system browser has just been handed the Google authorization URL.
  /// Like yieldForSettings there is no completion to restore on -- consent
  /// happens in another application and nothing calls back -- so this one
  /// takes no argument and the way back is the owner returning to the app.
  func yieldOnboardingToBrowser()
  /// A LinkedIn export landed without anyone pressing a button on a page: the
  /// Downloads watcher found one, or a file was dropped on the settings panel.
  /// The two surfaces that render its state repaint themselves — without this,
  /// screen 4 goes on saying "waiting for your file" about a file that is
  /// already installed.
  func linkedInExportChanged()
}

final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, URLSessionTaskDelegate {

  // WHICH PAGE MAY ASK FOR WHAT.
  //
  // Every webview registers this same Bridge under the same handler name, so
  // until this table existed the dispatch switched on the message type alone and
  // any page could call anything: onboarding could start a bridge login, the
  // connections popup could ask a question, and any of them could post a
  // voiceTranscript for an utterance the microphone never heard.
  //
  // Nothing exploited that -- the pages are local, every one carries a CSP, and
  // the only innerHTML writes escape properly -- so this is a compartment, not a
  // patch. The reason to build it anyway is the blast radius: the day a page does
  // render something untrusted, the answer should be "it could call three things"
  // rather than "it could call everything". The check is cheap because the
  // message already arrives with its webView.
  //
  // Derived from what each page actually calls (grep hzPost across widget/ui).
  // ~~`markHandheld` has no caller today and is listed under connections
  // because that is the surface it is about.~~ That was the exception this
  // header warns about, kept for a page that never called it: it went with
  // `openOnboarding` in the surface review (2026-09-13), dispatch case and all.
  // A case missing from every list here is a test failure, not a silent 404 --
  // see widget/test/bridge-capabilities.test.mjs.
  static let sharedActions: Set<String> = [
    // bridge.js is loaded by every page, so these two are everyone's.
    "prefs", "fitContent",
  ]
  static let pageCapabilities: [String: Set<String>] = [
    "widget": ["drag", "openChat", "openChatWith", "openConnections",
               "openMonths", "openReconnect", "voiceArm", "widgetBounds",
               "chatBarOpen",
               "workStatus", "relCardPeek", "relEvent", "relRefresh"],
    "chat": ["ask", "cancel", "chatReady", "close", "decideClaim",
             "frontierSend", "frontierCancel"],
    // The reconnect card popup (L5 step 10): reads the current card, posts
    // the owner's verdict, sizes itself, and (the mode picker) asks for a
    // fresh batch under a different mode. Nothing else -- the card page
    // holds no token and can open no other surface.
    // `openProfile` is the one door out of this page, and it is a door to one
    // shape of address: https + linkedin.com + /in/, checked natively. The card
    // shows a person's own job title now, and the profile it came from is the
    // obvious next thing to look at.
    "reconnect": ["relCard", "relEvent", "relRefresh", "relMode", "relDraft", "close", "fitContent",
                  "openProfile"],
    "connections": ["bridgeBegin", "bridgeCookies", "bridgeStatus", "bridgeWebLogin",
                    "bridgeDiscordServer",
                    "close", "connectorsIntroSeen", "openConnectLink", "openExternal",
                    "status", "setConnectorEnabled", "setMotion", "setScale", "setSounds",
                    "setPerformance", "setKeepAwake",
                    // The one switch that decides whether excerpts leave this
                    // Mac. It lived only in onboarding, so once the flow was
                    // done the owner could never see or change it again.
                    "engineProbe", "setEngine",
                    // Leaving, and leaving for good: quit has no other door in
                    // an LSUIElement app with no menu bar, and uninstall was a
                    // shell script in a repo the owner will never find.
                    "quitApp", "uninstallApp",
                    // What the daily card is set to, read straight from the
                    // owner config. A READ, not a run: GET /admin/config/card
                    // answers mode/capPerDay/producer/engine without touching
                    // the producers, which is why settings may ask for it on
                    // every render and the card peek stays out of this panel.
                    "cardConfig",
                    // The export card's file picker. The shelf's hint used to
                    // tell the owner to put Connections.csv in a dotfile path
                    // by hand, while onboarding screen 4 did the same job with
                    // this panel. One way to do it now, and it is this one.
                    "importLinkedIn",
                    // ...and what is already installed, so the settings row can
                    // read "2,970 connections · <date>" rather than offering a
                    // picker for a file the owner handed over last month.
                    // Counts and a date; no row content. See linkedInState().
                    "linkedInState",
                    "activity",
                    "openFullDiskAccess", "startSources",
                    // In-panel API-key walkthroughs and Google OAuth.
                    "connectSecret", "openApp", "googleAuth",
                    "permissionState", "requestPermission"],
    // The six-screen setup flow. Every entry here is a CHECK the page runs or
    // a thing a check writes -- there is no verb in this list the page does
    // not call, and widget/test/onboarding-capabilities.test.mjs enforces
    // both directions. `openPeople` is gone: the flow now ends on the
    // reconnect card, which is what it spent six screens getting ready.
    "onboarding": ["close", "moveToApplications", "onboardingDone", "spotlightWidget",
                   "widgetSpot",
                   // Screen 1: the mode row, read through a peek that records
                   // nothing and written only on an actual click.
                   "relMode", "relCardPeek",
                   // Screen 2: the permission rows and the reader they start.
                   "openFullDiskAccess", "startSources",
                   "permissionState", "requestPermission",
                   // Screen 3: the grant, and the live read that proves it.
                   "googleAuth", "googleProbe",
                   // Screen 4: ASK FOR THE FILE, then take it whenever it turns
                   // up. `openLinkedInExport` opens LinkedIn's download page in
                   // the owner's browser -- one fixed address, no URL from the
                   // page. `importLinkedIn` is the picker, which now also takes
                   // the zip LinkedIn sends. `linkedInState` is what is already
                   // on disk from a previous run.
                   "openLinkedInExport", "importLinkedIn", "linkedInState",
                   // Screen 5: whether the installed claude actually works,
                   // the opt-in it may then offer, and the local model for a
                   // Mac that has no claude on it.
                   "engineProbe", "setEngine",
                   "setupState", "modelDownload", "modelCancel",
                   // Screen 6: the live table, and the panel the flow ends on.
                   "onboardingProgress", "openReconnect",
                   // Which scene is up, remembered so a restart resumes on it.
                   "onboardingStep"],
    // people.html includes connector-tile.js as well as people.js (check the
    // script tags, not the file's own comment about being shared), so the People
    // popup renders connector tiles and needs the bridge verbs too. Writing this
    // map from the wrong file cost one broken popup in review.
    "people": ["close", "initSearch", "peopleDecide", "peopleReview", "status",
               "bridgeBegin", "bridgeCookies", "bridgeStatus", "bridgeWebLogin",
               "bridgeDiscordServer",
               "connectorsIntroSeen", "openExternal", "setConnectorEnabled", "connectSecret", "openApp",
               "openFullDiskAccess", "googleAuth", "openReconnect"],
    // peopleFind: search across every year, server-ranked. peopleMap: the
    // ALL-YEARS source behind the constellation — every person, uncapped, with
    // their per-year topics. monthsView: where the popup was left, so a restart
    // resumes on it rather than snapping back to this year.
    "people-months": ["close", "peopleYear", "peopleFind", "peopleSelf", "peopleRole",
                      "openPeople", "monthsView", "peopleMap", "peopleAvatars"],
    "ear": ["orbState", "voiceError", "voiceTranscript"],
  ]

  // Set by the factories in Windows.swift at creation. ObjectIdentifier rather
  // than the URL: the page's own address is a thing the page influences, and
  // identity here should come from the code that made the view.
  private var pageOf: [ObjectIdentifier: String] = [:]

  // Deliveries waiting on a page that has not finished loading. See
  // whenPageFinishes, below the navigation delegate that drains it.
  private var afterLoad: [ObjectIdentifier: [(WKWebView) -> Void]] = [:]

  func register(_ webView: WKWebView, as page: String) {
    pageOf[ObjectIdentifier(webView)] = page
  }

  private func allows(_ webView: WKWebView, _ type: String) -> Bool {
    if Bridge.sharedActions.contains(type) { return true }
    guard let page = pageOf[ObjectIdentifier(webView)],
          let allowed = Bridge.pageCapabilities[page] else { return false }
    return allowed.contains(type)
  }

  // The faces the widget page knows how to wear. Allow-listed here rather
  // than passed through, because this string is interpolated into JavaScript
  // on the other side — an unrecognised value must never reach it.
  static let orbFaces: Set<String> = ["idle", "notify", "listening", "talking"]

  /// Interactive local-model work started from a panel. The connector, index
  /// and model-download states already have their own truthful owners; this
  /// small tracker covers asks so the desktop orb does not fall asleep while
  /// the user is waiting for a result they requested.
  private final class WorkTracker {
    private let lock = NSLock()
    private var jobs: [UUID: String] = [:]

    func begin(_ label: String) -> UUID {
      let id = UUID()
      lock.lock(); jobs[id] = label; lock.unlock()
      return id
    }

    func finish(_ id: UUID) {
      lock.lock(); jobs.removeValue(forKey: id); lock.unlock()
    }

    var label: String? {
      lock.lock(); defer { lock.unlock() }
      return jobs.values.sorted().first
    }
  }
  private static let activeWork = WorkTracker()
  private var automaticModelTimer: Timer?
  private var automaticModelWorkLabel: String?
  private var automaticModelSupervisorsPaused = false

  /// Re-evaluate the hardware-selected model after launch, but never replace a
  /// live model under queued or active work. The first check waits a minute so
  /// the connector daemon has time to publish its real queue after an app
  /// upgrade. A pending change survives restarts in the fingerprint mismatch;
  /// no separate fragile "upgrade in progress" flag is needed.
  func reconcileAutomaticModelWhenSafe() {
    automaticModelTimer?.invalidate()
    automaticModelTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) {
      [weak self] _ in self?.beginAutomaticModelReconciliation()
    }
  }

  private func beginAutomaticModelReconciliation() {
    // `allowFreshInstall` IS DEAD and this is the last caller passing it.
    // ModelSetup.automaticTarget discards the value (`_ = allowFreshInstall`,
    // ModelSetup.swift) — the fresh-install case is decided by `installed ==
    // nil` inside the function instead. It was bound to a local here, which
    // made the call site read as though onboarding state still influenced the
    // answer. Inlined so nothing in this file implies a dependency that is
    // not there; deleting the PARAMETER belongs to ModelSetup.swift.
    guard let tier = ModelSetup.automaticTarget(allowFreshInstall: false) else {
      return
    }
    let replacingExisting = ModelSetup.installed != nil
    if !automaticModelSwitchIsSafe {
      retryAutomaticModelReconciliation()
      return
    }
    stageAutomaticModel(tier, replacingExisting: replacingExisting)
  }

  private var automaticModelSwitchIsSafe: Bool {
    !ModelSetup.isDownloading
      && Bridge.activeWork.label == nil
      && Connectors.shared.activeWorkLabel == nil
      && Connectors.shared.queuedWorkLabel == nil
      && Distiller.shared.activity == nil
  }

  private func retryAutomaticModelReconciliation(after seconds: TimeInterval = 30) {
    automaticModelTimer?.invalidate()
    automaticModelTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) {
      [weak self] _ in self?.beginAutomaticModelReconciliation()
    }
  }

  /// Download beside the active model. activate=false is load-bearing: work is
  /// free to start during a multi-gigabyte fetch, and the symlink must continue
  /// pointing at the old model until a second idle check passes.
  private func stageAutomaticModel(_ tier: String, replacingExisting: Bool) {
    automaticModelWorkLabel = "preparing the best local model for this Mac"
    ModelSetup.download(
      tierId: tier, activate: false,
      progress: { [weak self] got, total in
        self?.delegate?.setupProgress([
          "phase": "downloading", "got": got, "total": total, "tier": tier,
        ])
      },
      done: { [weak self] failure in
        guard let self else { return }
        if let failure {
          self.automaticModelWorkLabel = nil
          self.resumeAutomaticModelSupervisors()
          if failure != "cancelled" {
            ModelSetup.notify(title: "Model update didn’t finish", body: failure)
          }
          return
        }
        if replacingExisting && !self.automaticModelSwitchIsSafe {
          self.waitToActivateAutomaticModel(tier)
        } else {
          self.activateAutomaticModel(tier)
        }
      })
  }

  private func waitToActivateAutomaticModel(_ tier: String) {
    automaticModelTimer?.invalidate()
    automaticModelTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) {
      [weak self] _ in
      guard let self else { return }
      if self.automaticModelSwitchIsSafe { self.activateAutomaticModel(tier) }
      else { self.waitToActivateAutomaticModel(tier) }
    }
  }

  private func activateAutomaticModel(_ tier: String) {
    // The download is safe beside the live model. Stop local workers only for
    // the short symlink/service handoff, after one last idle check.
    guard automaticModelSwitchIsSafe else {
      waitToActivateAutomaticModel(tier)
      return
    }
    pauseAutomaticModelSupervisors()
    let previous = ModelSetup.installed?.id
    do {
      try ModelSetup.activate(tierId: tier)
    } catch {
      automaticModelWorkLabel = nil
      resumeAutomaticModelSupervisors()
      return
    }
    automaticModelWorkLabel = "starting the best local model for this Mac"
    delegate?.setupProgress(["phase": "installing", "tier": tier])
    DispatchQueue.global(qos: .utility).async { [weak self] in
      guard let self else { return }
      guard Provision.ensureLlamaRuntime() else {
        self.rollbackAutomaticModel(to: previous)
        return
      }
      Provision.installAgent("io.intaglio.llama-server")
      Provision.installAgent("io.intaglio.hermes")
      if Provision.waitForLlama() {
        ModelSetup.markAutomaticSelectionCurrent()
        DispatchQueue.main.async {
          self.automaticModelWorkLabel = nil
          self.resumeAutomaticModelSupervisors()
          self.delegate?.setupProgress(["phase": "ready", "tier": tier])
          ModelSetup.notify(
            title: "Local model optimized",
            body: "Intaglio Labs selected the best safe model for this Mac.")
        }
      } else {
        self.rollbackAutomaticModel(to: previous)
      }
    }
  }

  private func rollbackAutomaticModel(to previous: String?) {
    if let previous { try? ModelSetup.activate(tierId: previous) }
    else if let attempted = ModelSetup.installed?.id { ModelSetup.deactivate(tierId: attempted) }
    Provision.installAgent("io.intaglio.llama-server")
    Provision.installAgent("io.intaglio.hermes")
    DispatchQueue.main.async { [weak self] in
      self?.automaticModelWorkLabel = nil
      self?.resumeAutomaticModelSupervisors()
      ModelSetup.notify(
        title: "Model update didn’t finish",
        body: previous == nil
          ? "The model is saved and Intaglio Labs will try to start it again later."
          : "The previous local model is still active. Intaglio Labs will try again later.")
    }
  }

  private func pauseAutomaticModelSupervisors() {
    guard !automaticModelSupervisorsPaused else { return }
    automaticModelSupervisorsPaused = true
    Connectors.shared.pauseForModelMaintenance()
    Distiller.shared.pauseForModelMaintenance()
  }

  private func resumeAutomaticModelSupervisors() {
    guard automaticModelSupervisorsPaused else { return }
    automaticModelSupervisorsPaused = false
    Connectors.shared.resumeAfterModelMaintenance()
    Distiller.shared.resumeAfterModelMaintenance()
  }

  // The per-app Reduce Motion override. macOS Reduce Motion is a SYSTEM
  // accessibility setting and the widget honours it by default; this is the
  // ordinary per-app opt-back-in for someone who wants the animation anyway.
  // Both prefs live in native storage because the webviews are configured
  // .nonPersistent() (Windows.swift), so nothing a page stores survives a
  // relaunch. Default false: a fresh install always respects the setting.
  static let motionDefaultsKey = "HazlieMotionAnyway"
  static var motionAnyway: Bool {
    get { UserDefaults.standard.bool(forKey: motionDefaultsKey) }
    set { UserDefaults.standard.set(newValue, forKey: motionDefaultsKey) }
  }

  // Whether the welcome flow has been completed. False on a fresh install,
  // which is what makes onboarding open by itself the first time.
  static let onboardedDefaultsKey = "HazlieOnboarded"
  static var onboarded: Bool {
    get { UserDefaults.standard.bool(forKey: onboardedDefaultsKey) }
    set { UserDefaults.standard.set(newValue, forKey: onboardedDefaultsKey) }
  }

  // WHICH FLOW SOMEBODY COMPLETED, recorded but NOT used to force a replay.
  //
  // This gate used to read `!onboarded || revision < current`, which replays the
  // whole welcome for every existing install: `onboarded` is true for them and
  // the revision key is absent, and UserDefaults reads a missing integer as 0,
  // so 0 < 2 and the flow runs again on the next launch.
  //
  // Redesigning the flow is not a reason to make somebody sit through it. They
  // have already granted the permissions, chosen a model and downloaded it --
  // the whole point of the welcome -- and a finished setup that reopens itself
  // reads as the app having lost their data, which is the single most alarming
  // thing this app could imply. The gear replays it on demand for anyone who
  // wants to see what changed.
  //
  // The stamp stays because it is worth knowing which flow a person saw, and
  // because a future change that genuinely does need an existing install to
  // revisit something can opt in HERE, deliberately, rather than by the side
  // effect of a version bump.
  static let onboardingRevisionDefaultsKey = "HazlieOnboardingRevision"
  static let currentOnboardingRevision = 2
  static var needsOnboarding: Bool { !onboarded }
  static func completeOnboarding() {
    onboarded = true
    UserDefaults.standard.set(currentOnboardingRevision, forKey: onboardingRevisionDefaultsKey)
  }

  // WHICH SCENE THE FLOW WAS ON, so a restart resumes rather than rewinds.
  //
  // Granting Full Disk Access to a running app makes macOS offer "Quit &
  // Reopen" — and taking it dropped the owner back on the welcome screen, to
  // walk the whole flow again, having just done the hardest step in it. The
  // page reports each scene as it opens; a first-run launch resumes on the
  // last one reported, and finishing clears it.
  // WHERE THE TIMELINE POPUP WAS LEFT: the year, whether the list or the globe
  // was up, and the topic it was filtered to. Remembered for the same reason
  // onboardingStep is — the panel survives hidden with its page state intact,
  // so closing and reopening already returns you where you were, but a RESTART
  // recreates the page and it came back on the current year with nothing
  // selected. Landing somewhere other than where you left reads as the app
  // having thrown your place away.
  //
  // One opaque string, written and parsed by people-months.js. Native does not
  // interpret it: what "where you were" means belongs to the page, and giving
  // this key a schema would mean changing Swift every time the page grows a
  // fourth thing to remember.
  static let monthsViewKey = "HazlieMonthsView"
  static var monthsView: String? {
    get { UserDefaults.standard.string(forKey: monthsViewKey) }
    set {
      if let v = newValue { UserDefaults.standard.set(v, forKey: monthsViewKey) }
      else { UserDefaults.standard.removeObject(forKey: monthsViewKey) }
    }
  }

  // VERSIONED, because the vocabulary changed under the same key.
  //
  // The old flow had three scenes and wrote '1', '2', '3' for welcome, typing
  // demo and widget spotlight. The six-screen flow writes the same characters
  // for welcome, permissions and Google sign-in. An owner who FINISHED the old
  // flow yesterday has a '3' on disk meaning "the last screen", and the new
  // build reads it as "resume into Google sign-in" — dropping them back into
  // the middle of a flow they completed, and skipping the permissions screen
  // that everything else depends on. There is no way to tell the two apart by
  // value, so the KEY carries the version and a value written under the old
  // one is not read at all. The legacy key is removed rather than left to rot.
  static let legacyStepDefaultsKey = "HazlieOnboardingStep"
  static let stepDefaultsKey = "HazlieOnboardingStep-v2"
  static var onboardingStep: String? {
    get {
      UserDefaults.standard.removeObject(forKey: legacyStepDefaultsKey)
      return UserDefaults.standard.string(forKey: stepDefaultsKey)
    }
    set {
      if let v = newValue { UserDefaults.standard.set(v, forKey: stepDefaultsKey) }
      else { UserDefaults.standard.removeObject(forKey: stepDefaultsKey) }
    }
  }

  // Interface sounds. Unlike Reduce Motion there is no system setting to
  // inherit, so this defaults ON — and an absent key has to be checked for
  // explicitly, because UserDefaults reads a missing Bool as false and would
  // otherwise ship every fresh install silent.
  // See case "widgetBounds": CSS-px offset of the visible widget's left edge
  // within its window. nil until the page first reports.
  static var widgetVisibleLeftCSS: Double? = nil

  static let soundsDefaultsKey = "HazlieSounds"
  static var soundsOn: Bool {
    get {
      guard UserDefaults.standard.object(forKey: soundsDefaultsKey) != nil else { return true }
      return UserDefaults.standard.bool(forKey: soundsDefaultsKey)
    }
    set { UserDefaults.standard.set(newValue, forKey: soundsDefaultsKey) }
  }

  // How big the widget is drawn. One number: the widget window, both popups
  // and every page's zoom are all derived from it (main.swift applyScale), so
  // the whole surface grows together rather than the panel growing around a
  // fixed-size layout.
  //
  // Absent has to be checked for explicitly — UserDefaults reads a missing
  // Double as 0, and a fresh install would open at zero size with no window
  // to fix it from. Clamped on both read and write: the value crosses the
  // bridge from a page, and out-of-range is what makes a borderless window
  // unreachable.
  static let scaleDefaultsKey = "HazlieScale"
  static let scaleRange: ClosedRange<Double> = 0.7...1.6
  static var scale: Double {
    get {
      guard UserDefaults.standard.object(forKey: scaleDefaultsKey) != nil else { return 1 }
      return clampScale(UserDefaults.standard.double(forKey: scaleDefaultsKey))
    }
    set { UserDefaults.standard.set(clampScale(newValue), forKey: scaleDefaultsKey) }
  }
  static func clampScale(_ v: Double) -> Double {
    guard v.isFinite else { return 1 }
    return min(max(v, scaleRange.lowerBound), scaleRange.upperBound)
  }

  // THE INTENT OUTLIVES THE REQUEST THAT CARRIES IT.
  //
  // Pressing screen 1's button is the owner accepting one card a day, and
  // startReadingSources posts that to hermes. hermes on a first launch is
  // often still warming, and the post was fire-and-forget: one refused
  // connection and relationshipMemory.capPerDay was never written, which makes
  // hermes' card route answer no-cap-configured for ever. The press is
  // recorded HERE first, so a post that cannot land today is retried on the
  // next launch until it lands once. Cleared by the first reply that says the
  // settings were taken.
  static let cardDefaultsPendingKey = "HazlieCardDefaultsPending"
  static var cardDefaultsPending: Bool {
    get { UserDefaults.standard.bool(forKey: cardDefaultsPendingKey) }
    set { UserDefaults.standard.set(newValue, forKey: cardDefaultsPendingKey) }
  }

  // THE MODE THE OWNER PICKED, ON THE SAME TERMS AS THE CAP.
  //
  // The mode route answers 200 with `persisted: false` when its config write
  // fails: the choice is live in the running reader and only its durability
  // broke. The page retried once and then wrote a quiet note — so hermes being
  // down for a whole first session lost the pick with nothing but a sentence
  // the owner may have scrolled past, while `capPerDay`, chosen on the same
  // screen, landed on a later launch.
  //
  // Same shape as the cap: the choice is written down HERE first and delivered
  // until a reply says it was kept. The note is still written for the session
  // the owner is in, because "it will be there next launch" is not what they
  // asked for; it is the floor under that sentence rather than a replacement.
  // EXPORTS WHOSE VINTAGE THIS APP COULD NOT ESTABLISH.
  //
  // The staging swap stamps the export's own date onto the installed copy so
  // PASS ONE can ask how old it is. Two things have to go wrong together and
  // then it cannot: the archive carries no readable date AND setResourceValues
  // throws. Both dates are then the moment the copy landed, installedVintage
  // answers "now", and the refusal below reads the owner's own file as older
  // than the one they have -- permanently, with no way past it but deleting the
  // file by hand. That is a flow that cannot be completed, which is a worse
  // outcome than any re-import.
  //
  // So the app writes down that it does not know, and a date it does not know
  // is not evidence to refuse on. Cleared the moment a stamp lands.
  static let unstampedImportsKey = "HazlieUnstampedImports"
  static var unstampedImports: [String] {
    get { UserDefaults.standard.stringArray(forKey: unstampedImportsKey) ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: unstampedImportsKey) }
  }

  /// The modes hermes accepts (ui/server/people/owner.mjs RELATIONSHIP_MODES),
  /// and the values onboarding.html's picker carries. Restated rather than
  /// derived because nothing crosses that boundary at build time — and pinned to
  /// the page by widget/test/first-run-waiting.test.mjs so the two cannot drift.
  static let relationshipModes: Set<String> = ["founder", "investor", "any"]

  /// The one-off mode the reconnect panel's NEXT pull should use, handed over by
  /// onboarding's "just this once" button. Instance state and not UserDefaults:
  /// see the openReconnect case.
  private var pendingOneOffMode: String?

  /// How many launches a pending mode may survive. The retry exists for a hermes
  /// that is down today; a value it refuses is not going to start being accepted
  /// on the ninth morning, and a pending write with no ceiling is a request this
  /// app makes for the life of the install.
  static let cardModeMaxLaunches = 8
  static let cardModeLaunchesKey = "HazlieCardModeLaunches"
  static var cardModeLaunches: Int {
    get { UserDefaults.standard.integer(forKey: cardModeLaunchesKey) }
    set { UserDefaults.standard.set(newValue, forKey: cardModeLaunchesKey) }
  }

  static let cardModePendingKey = "HazlieCardModePending"
  static var cardModePending: String? {
    get { UserDefaults.standard.string(forKey: cardModePendingKey) }
    set { UserDefaults.standard.set(newValue, forKey: cardModePendingKey) }
  }

  // The handoff out of onboarding: after the flow finishes, the widget's
  // gear nudges until settings is opened once, and that first open runs the
  // connectors intro. Reset by every completed flow, so replay hands off
  // like the first time.
  static let connectorsIntroKey = "HazlieConnectorsIntro"
  static var connectorsIntroDone: Bool {
    get { UserDefaults.standard.bool(forKey: connectorsIntroKey) }
    set { UserDefaults.standard.set(newValue, forKey: connectorsIntroKey) }
  }

  // Which connectors have already hand-held — by KIND (both mail accounts
  // are one "mail"), persisted natively because the webviews forget
  // everything at relaunch. A connector's first press walks the user
  // through; every later press is the compact hint.
  static let handheldKey = "HazlieHandheld"
  static var handheld: [String] {
    get { UserDefaults.standard.stringArray(forKey: handheldKey) ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: handheldKey) }
  }

  // Grant mic capture to our own ear page only; the OS-level TCC prompt for
  // Hazlie.app still gates the first use. Any other origin is denied.
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    let own = origin.protocol == AssetSchemeHandler.scheme
    decisionHandler(own && type == .microphone ? .grant : .deny)
  }
  weak var delegate: BridgeDelegate?

  // The ONLY two places this process may talk to.
  private let hermesBase = URL(string: "http://127.0.0.1:51789")!
  private let connectBase: URL = {
    // Dev override for the port ONLY — the host is not configurable. Lets a
    // second connect instance (e.g. --port 8790 from a worktree) serve the
    // widget without touching the launchd one.
    var port = 51788
    if let s = ProcessInfo.processInfo.environment["HAZLIE_CONNECT_PORT"],
       let p = Int(s), (1024...65535).contains(p) { port = p }
    return URL(string: "http://127.0.0.1:\(port)")!
  }()

  private lazy var session: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 120 // a buffered 8B answer is legitimately slow
    cfg.httpShouldSetCookies = false
    return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
  }()

  private var askTask: URLSessionDataTask?
  // The transcript (not typed text) still waiting for its ask, matched by
  // TEXT: the ear page posts the transcript and the chat page posts the ask
  // with no shared id between them, so identical text (both sides trim and
  // cap the same way) is the only join. Lifecycle: set on voiceTranscript,
  // consumed by the ask that matches it, and cleared by the next TYPED
  // message (openChatWith) — typing supersedes a spoken turn, so a
  // transcript the busy chat page silently dropped can never claim a later
  // identical typed ask. A non-matching ask leaves it alone, because the
  // transcript may still be queued behind that ask (load-time messages are
  // delivered one ask at a time).
  private var pendingVoiceUtterance: String?

  // Only desktop applications named by the connector UI may be launched.
  // com.docker.docker was here so the nobridge notice could offer to start
  // Docker Desktop; nothing asks for it now that the bridges run natively, and
  // an allowlist entry no caller uses is a capability granted for free.
  private let allowedApps: Set<String> = ["com.granola.app"]

  // The only external destinations this app will hand to the OS. Opening
  // one launches the default browser (or System Settings) — the app itself
  // still opens no socket beyond loopback; the user's click on a fixed help
  // link is what leaves, same posture as the connect page's help topics.
  private let allowedExternal: Set<String> = [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    "https://myaccount.google.com/apppasswords",
    "https://granola.ai",
    "https://cloud.ouraring.com/oauth/applications",
    "https://www.notion.so/my-integrations",
    // Telegram's app registration — each install gets its own api_id/api_hash.
    //
    // RESTORED IN THE MERGE (2026-08-26). This entry and the walkthrough that
    // sends the owner to it were both present at 72b5960 and both absent by
    // 91e8285, and 72b5960 is an ancestor of it — so they were lost, not never
    // written. The loss is in `0f17d26` "Merge updated connector onboarding
    // branch": its two parents were 2e58f17 (no walkthrough) and 72b5960 (two),
    // and it resolved widget/ui/connections.js and this file toward the side
    // that had neither.
    //
    // ~~"lost when the People-tab PR (9176ef8) reverted these files".~~ WRONG,
    // and corrected here rather than left standing: 9176ef8 is innocent, its
    // connections.js diff is +17/-10 and touches neither. A reviewer traced it
    // properly and I had blamed the wrong commit. Worth the correction because
    // the true cause is a different KIND of bug — not a PR overwriting a file,
    // but a merge silently choosing the older side — and `git log -S` will not
    // find it, because it skips merge commits by default. That is exactly where
    // a loss like this hides.
    //
    // None of it was ever on main; it is branch work. connectors/test/
    // openExternal.test.mjs is what caught the survivor half — the walkthrough
    // came through the merge, its allowlist entry did not, and the symptom
    // would have been a link that does nothing.
    "https://my.telegram.org/apps",
    // The bridge token how-to links, for the Discord/Slack guided login flows.
    "https://docs.mau.fi/bridges/go/discord/authentication.html",
    "https://docs.mau.fi/bridges/go/slack/authentication.html",
    // LinkedIn's own "get a copy of your data" page, which is where BOTH doors
    // to the export lead: the settings shelf's export card (the linkedin-export
    // hint in connections.js) through openExternal, and onboarding screen 4's
    // "request a copy" through openLinkedInExport.
    //
    // NO SQUARE BRACKETS IN THIS BLOCK, in a comment or anywhere else.
    // openExternal.test.mjs reads the declaration up to its first closing
    // bracket, so a comment spelling a JS subscript truncates the allowlist the
    // test is scanning and every real URL below it then reads as missing. Cost
    // two rounds here to find, once for the subscript and once for the sentence
    // warning about the subscript.
    //
    // IT WAS MISSING, and the symptom is the one this allowlist's test exists to
    // catch: connections.js has sent this string since the export card came
    // back, nothing allowed it, openExternal answered "url not in allowlist",
    // and the only link on that card did nothing.
    // connectors/test/openExternal.test.mjs was already failing on it.
    //
    // Written out rather than interpolated from linkedInExportPage below,
    // because that test reads STRING LITERALS out of this declaration and an
    // identifier would read as an empty allowlist. The two are pinned to each
    // other by the guard in openLinkedInExport, and by
    // widget/test/linkedin-export-handoff.test.mjs.
    "https://www.linkedin.com/mypreferences/d/download-my-data",
  ]

  /// Where "request a copy" sends the owner. ONE fixed address, so the page
  /// passes no URL at all and this constant is what gets opened — see the
  /// `openLinkedInExport` case for why that is a different door from
  /// `openProfile`, which pins a host because its path is per-person.
  static let linkedInExportPage = "https://www.linkedin.com/mypreferences/d/download-my-data"

  // Refuse every redirect: a redirect is how a compromised loopback response
  // would move the bearer token somewhere else.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  // THE SIZE HAS TO BE APPLIED HERE, not next to the load.
  //
  // pageZoom is reset by navigation, and makeWebView starts the load before
  // it returns — so every caller that sets pageZoom on the webview it was
  // just handed is racing the first commit and quietly loses. That is what
  // shipped: the widget WINDOW came back at the stored size on relaunch while
  // the page inside it drew at 100%, which reads exactly like a widget being
  // constrained by a box that grew around it.
  //
  // Doing it on didFinish covers the first load and every reload, for every
  // page, and callers no longer have to remember. Live changes still go
  // through scaleChanged, which is the case this cannot see.
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.pageZoom = Bridge.scale
    for work in afterLoad.removeValue(forKey: ObjectIdentifier(webView)) ?? [] { work(webView) }
  }

  /// Work to run the next time this page finishes loading.
  ///
  /// FOR THE WORD THAT ARRIVED TOO EARLY. A caller that evaluates JavaScript
  /// against a panel it has just built is talking to a document that may not
  /// have parsed its script yet — WebKit runs the evaluation when the document
  /// exists, which on a cold first launch can be seconds after the call and
  /// after the owner has started pressing things. The caller checks whether
  /// the page answered and, if it did not, leaves the delivery here to be made
  /// again once there is a page to make it to.
  ///
  /// One-shot and main-queue only, like every other webview touch here. A page
  /// that never finishes loading keeps its closure; that is one closure on a
  /// window the app holds anyway, and the alternative (a timer) would have to
  /// guess at the same answer.
  func whenPageFinishes(_ web: WKWebView, _ work: @escaping (WKWebView) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    afterLoad[ObjectIdentifier(web), default: []].append(work)
  }

  // Webviews may navigate to file: URLs and nowhere else.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let url = navigationAction.request.url
    let ok = url?.isFileURL == true || url?.scheme == AssetSchemeHandler.scheme
    decisionHandler(ok ? .allow : .cancel)
  }

  // MARK: messages

  private func dbg(_ line: String) {
    guard ProcessInfo.processInfo.environment["HAZLIE_DEBUG_ARM"] == "1" else { return }
    let f = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/logs/widget-asset.log")
    let msg = "bridge: " + line + "\n"
    if let h = try? FileHandle(forWritingTo: f) { h.seekToEndOfFile(); h.write(msg.data(using: .utf8)!); try? h.close() }
    else { try? msg.write(to: f, atomically: true, encoding: .utf8) }
  }

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "hz",
          let body = message.body as? [String: Any],
          let id = body["id"] as? Int,
          let type = body["type"] as? String,
          let webView = message.webView
    else { dbg("DROPPED message: \(String(describing: message.body).prefix(120))"); return }
    dbg("recv \(type)")
    // Fail closed: an unregistered view, or a page asking for something outside
    // its compartment, gets an error rather than the action.
    guard allows(webView, type) else {
      let page = pageOf[ObjectIdentifier(webView)] ?? "unregistered"
      dbg("REFUSED \(type) from \(page)")
      reply(webView, id, ["state": "error", "error": "action not available to this surface"])
      return
    }
    let payload = body["payload"] as? [String: Any] ?? [:]

    switch type {
    case "openChat":
      delegate?.openChat()
      reply(webView, id, ["state": "ok"])
    case "openChatWith":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      if !utterance.isEmpty {
        // A typed message supersedes any voice turn still waiting: without
        // this, a transcript the busy chat page dropped would linger and
        // could claim a later typed ask with the same words for the speaker.
        pendingVoiceUtterance = nil
        delegate?.openChat(with: utterance)
      }
      reply(webView, id, ["state": "ok"])
    case "chatReady":
      reply(webView, id, [
        "state": "ok",
        "pending": delegate?.takePendingUtterance() ?? "",
        "note": { let n = delegate?.takePendingVoiceNote() ?? ""; self.dbg("chatReady note='\(n.prefix(40))'"); return n }(),
      ])
    case "voiceArm":
      delegate?.armVoice()
      reply(webView, id, ["state": "ok"])
    case "voiceTranscript":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      if !utterance.isEmpty {
        pendingVoiceUtterance = utterance
        delegate?.voiceTranscript(utterance)
      }
      reply(webView, id, ["state": "ok"])
    case "voiceError":
      dbg("voiceError msg='\((payload["message"] as? String ?? "").prefix(60))'")
      delegate?.voiceNote(payload["message"] as? String ?? "voice error")
      reply(webView, id, ["state": "ok"])
    case "orbState":
      // The ear now names the face it wants — idle, listening or talking —
      // because a single boolean could not tell "Intaglio Labs is speaking" from
      // "the mic is open and the owner is". The boolean is still read as the
      // fallback, so an older ear page keeps working unchanged.
      if let face = payload["state"] as? String, Bridge.orbFaces.contains(face) {
        delegate?.setOrbFace(face)
      } else {
        delegate?.setOrbTalking(payload["talking"] as? Bool ?? false)
      }
      reply(webView, id, ["state": "ok"])
    case "openConnections":
      delegate?.openConnections()
      reply(webView, id, ["state": "ok"])
    case "openMonths":
      delegate?.openMonths()
      reply(webView, id, ["state": "ok"])
    case "openPeople":
      delegate?.openPeople()
      reply(webView, id, ["state": "ok"])
    case "openReconnect":
      // A WIDENING THAT TRAVELS EXACTLY ONE FETCH.
      //
      // Onboarding's "show me anyone, just this once" peeks under a one-off mode
      // and then hands over to this panel, which pulls under the STANDING mode --
      // the one with nobody in it. The owner pressed a button, the flow finished,
      // and the panel said "nothing to review" with their own chip lit. So the
      // mode rides here, is held for the panel's first pull, and is gone.
      //
      // In memory, deliberately: it is a hand-off inside one launch, and a
      // widening that survived a relaunch would be the durable write that button
      // exists not to make.
      if let mode = payload["oneOffMode"] as? String, Bridge.relationshipModes.contains(mode) {
        pendingOneOffMode = mode
      }
      delegate?.openReconnect()
      reply(webView, id, ["state": "ok"])
    case "widgetSpot":
      // Where the widget sits inside the onboarding window, as FRACTIONS of
      // that window rather than points. The page multiplies by its own
      // innerWidth/innerHeight, which makes the answer immune to pageZoom —
      // points would have to be divided by a zoom the page does not know.
      var spot = delegate?.widgetSpot() ?? [:]
      spot["state"] = 1
      reply(webView, id, spot)
    case "spotlightWidget":
      delegate?.spotlightWidget(payload["on"] as? Bool ?? false)
      reply(webView, id, ["state": "ok"])
    case "moveToApplications":
      // The app moves ITSELF — onboarding offers a button, not a Finder
      // tutorial. Copy the bundle to /Applications, hand a detached shell the
      // job of opening the new copy (detached, because the open must survive
      // this process quitting), remember the old path for the new instance to
      // delete, and terminate. Works from ~/Downloads and from a read-only
      // DMG alike; the copy is what breaks out of Gatekeeper's translocated
      // path.
      let src = Bundle.main.bundleURL
      let dst = URL(fileURLWithPath: "/Applications/Intaglio Labs.app")
      if src.path == dst.path || src.path.hasPrefix("/Applications/") {
        reply(webView, id, ["state": "ok", "moved": false]) // nothing to do
        break
      }
      do {
        let fm = FileManager.default
        try? fm.removeItem(at: dst)
        try fm.copyItem(at: src, to: dst)
        // The new instance deletes the copy we are running from — this one
        // cannot delete itself and then keep running long enough to relaunch.
        UserDefaults.standard.set(src.path, forKey: "HazlieStaleCopyPath")
        reply(webView, id, ["state": "ok", "moved": true])
        let relauncher = Process()
        relauncher.executableURL = URL(fileURLWithPath: "/bin/sh")
        relauncher.arguments = ["-c", "sleep 1; /usr/bin/open '/Applications/Intaglio Labs.app'"]
        try? relauncher.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          NSApp.terminate(nil)
        }
      } catch {
        reply(webView, id, ["state": "error", "error": "copy failed: \(error.localizedDescription)"])
      }
    // ~~case "openOnboarding"~~ and ~~case "markHandheld"~~ were removed with
    // the settings grants that were their only door (2026-09-13). Onboarding
    // still opens from native -- first run, a resumed flow and the `onboarding`
    // URL scheme all call main.swift's own openOnboarding -- and nothing ever
    // called markHandheld. A handled case no page may call is dead code that
    // looks live, and this file's own header says a granted-but-uncalled verb
    // is a re-widened surface; both directions now agree.
    case "onboardingDone":
      // Only the flow finishing sets this. Dismissing with Escape closes the
      // window without sending it, so a flow backed out of returns next time.
      Bridge.completeOnboarding()
      // Nothing left to resume; a replay from settings starts at the welcome.
      Bridge.onboardingStep = nil
      // ...and the handoff arms: the gear will nudge until settings opens.
      Bridge.connectorsIntroDone = false
      reply(webView, id, ["state": "ok"])
    case "connectorsIntroSeen":
      // The settings page reports it actually SHOWED the intro — the mark
      // lives there, not at window-open, so a race with the page's first
      // load cannot burn the intro unseen.
      Bridge.connectorsIntroDone = true
      reply(webView, id, ["state": "ok"])
    // LEAVING, AND LEAVING FOR GOOD. Both of these are settings rows, and both
    // exist because this app is LSUIElement: no menu bar, no ⌘Q, no status
    // item. Until they landed, the only ways to stop it were Activity Monitor
    // and a shell script in a repo.
    case "quitApp":
      // THE REPLY GOES FIRST. terminate() tears this webview down with the app,
      // so a reply sent after it never arrives and the page is left awaiting a
      // promise that cannot settle -- which is the last frame the owner sees.
      reply(webView, id, ["state": "ok"])
      // The services keep running: the launch agents are hermes, connect and
      // the model server, and none of them is this process. The READER is this
      // app's own child and stops with it (applicationWillTerminate), which is
      // what the row says.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { NSApp.terminate(nil) }

    case "uninstallApp":
      // NATIVE ASKS, NOT THE PAGE. A destructive confirm drawn in a webview is
      // a dialog the page could style, mistime or skip; an NSAlert is the one
      // the owner already trusts, and Uninstall.confirm lists what is actually
      // on this Mac rather than a generic sentence.
      let plan = Uninstall.plan()
      guard Uninstall.confirm(services: plan.services, apps: plan.apps) else {
        reply(webView, id, ["state": "ok", "cancelled": true])
        return
      }
      // OFF THE MAIN THREAD, AND NARRATED. Every step is a launchctl call with a
      // waitUntilExit, plus a bounded wait on the reader: on the main thread
      // that is a frozen window with nothing on screen saying why. The steps
      // land in the row the owner pressed, through the same one-way push the
      // model download uses.
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        let outcome = Uninstall.run { step in
          let literal = Bridge.jsString(step)
          DispatchQueue.main.async {
            webView.evaluateJavaScript(
              "window.__hzUninstallStep && window.__hzUninstallStep(\(literal))",
              completionHandler: nil)
          }
        }
        self.reply(webView, id, [
          "state": outcome.failures.isEmpty ? "ok" : "partial",
          "services": outcome.services,
          "apps": outcome.apps,
          "failures": outcome.failures,
          "dataKept": outcome.dataKept,
          "readerRestarted": outcome.readerRestarted,
        ])
        // A HALF-UNINSTALL STAYS ON SCREEN. Quitting on a failure takes the
        // window away along with the only account of what did not happen —
        // /Applications can refuse a delete, and the owner needs to be told
        // rather than left with an app that is still there and no explanation.
        if outcome.failures.isEmpty {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { NSApp.terminate(nil) }
        }
      }

    case "prefs":
      reply(webView, id, [
        "state": "ok",
        "motion": Bridge.motionAnyway,
        "sounds": Bridge.soundsOn,
        "performance": PowerBudget.mode.rawValue,
        "keepAwake": KeepMacAwake.enabled,
        "onboarded": !Bridge.needsOnboarding,
        "scale": Bridge.scale,
        "scaleMin": Bridge.scaleRange.lowerBound,
        "scaleMax": Bridge.scaleRange.upperBound,
        // Whether this process is running from the app's real home. Fresh
        // downloads run from ~/Downloads or a mounted DMG; onboarding's first
        // screen offers the move only when this is false. The env override
        // exists because the dev machine is always installed correctly and
        // the screen would otherwise be untestable.
        "inApplications": ProcessInfo.processInfo.environment["HAZLIE_FAKE_UNINSTALLED"] == "1"
          ? false : Bundle.main.bundlePath.hasPrefix("/Applications/"),
        "connectorsIntroDone": Bridge.connectorsIntroDone,
        "handheld": Bridge.handheld,
        // THE FEATURE REGISTRY, TO THE PAGES. Carried on `prefs` rather than on
        // a new verb because `prefs` is a sharedAction — bridge.js loads on
        // every page, so every page can ask, and no page's capability list has
        // to change to let it. See ops/FEATURES.md.
        //
        // Booleans only here, and the connectors table separately: a page
        // deciding whether to draw a tile needs the three-state value, and
        // flattening 'optional' to true/false at this boundary is exactly how
        // the connections page would lose the distinction it exists to show.
        "features": Dictionary(uniqueKeysWithValues:
          FeatureSet.names.map { ($0, Features.on($0)) }),
        "connectorFeatures": Dictionary(uniqueKeysWithValues:
          FeatureSet.connectorNames.map { name -> (String, Any) in
            switch Features.connector(name) {
            case .on: return (name, true)
            case .off: return (name, false)
            case .optional: return (name, "optional")
            }
          }),
      ])
    case "setMotion":
      let on = payload["on"] as? Bool ?? false
      Bridge.motionAnyway = on
      delegate?.motionAnywayChanged(on)
      reply(webView, id, ["state": "ok", "motion": on])
    case "fitContent":
      // A page telling native how tall it actually needs to be. The popups
      // have fixed base sizes, and a fixed size is a guess about content that
      // grows: the connector grid gained a third row and the last one was
      // simply cut off by the window edge.
      //
      // Same Int/Double dance as setScale: whole JS numbers arrive as Int.
      // Width is deliberately not page-controlled: connector hints are
      // overlays, and content must never grow a third panel beside Settings.
      let h = (payload["height"] as? Double) ?? Double(payload["height"] as? Int ?? 0)
      delegate?.fitPopup(webView, contentHeight: h)
      reply(webView, id, ["state": "ok"])
    case "setScale":
      // Accept Int as well as Double: a JS number that happens to be whole
      // arrives as an NSNumber that bridges to Int, and a slider parked on
      // 1.00 is exactly that case.
      let raw = (payload["value"] as? Double) ?? Double(payload["value"] as? Int ?? 1)
      let v = Bridge.clampScale(raw)
      // A drag applies live but does not persist; the value is written when
      // the thumb is released. Otherwise one pull across the range rewrites
      // UserDefaults forty times to land on the same number.
      let committed = (payload["commit"] as? Bool) ?? true
      if committed { Bridge.scale = v }
      // The sender is passed through so the window that OWNS the slider can be
      // left alone while the slider is being dragged — see scaleChanged.
      delegate?.scaleChanged(v, committed: committed, from: webView)
      reply(webView, id, ["state": "ok", "scale": v])
    case "setSounds":
      let on = payload["on"] as? Bool ?? false
      Bridge.soundsOn = on
      delegate?.soundsChanged(on)
      reply(webView, id, ["state": "ok", "sounds": on])
    case "setPerformance":
      guard let raw = payload["mode"] as? String,
            // migrate(), not init(rawValue:): a panel still holding the
            // pre-rename value must set the setting it means, not be rejected.
            let mode = PerformanceMode.migrate(raw) else {
        reply(webView, id, ["state": "error", "error": "unknown performance mode"])
        return
      }
      PowerBudget.mode = mode
      Connectors.shared.applyPerformanceMode()
      reply(webView, id, ["state": "ok", "performance": mode.rawValue])
    case "setKeepAwake":
      let on = payload["on"] as? Bool ?? false
      KeepMacAwake.enabled = on
      reply(webView, id, ["state": "ok", "keepAwake": on])
    case "close":
      // Closing chat hides the pending bubbles — the only cancel affordance —
      // so work left running would bill and block for up to its timeout with
      // nothing on screen naming it (review 2026-08-31). Chat only: another
      // page's close must not touch chat's jobs.
      if pageOf[ObjectIdentifier(webView)] == "chat" {
        askTask?.cancel()
        FrontierRunner.shared.cancel()
      }
      delegate?.closeWindow(of: webView)
      reply(webView, id, ["state": "ok"])
    case "drag":
      delegate?.dragWindow(of: webView)
      reply(webView, id, ["state": "ok"])
    case "chatBarOpen":
      delegate?.chatBarOpenChanged(payload["open"] as? Bool ?? false)
      reply(webView, id, ["state": "ok"])
    case "widgetBounds":
      // Where the VISIBLE widget starts inside its mostly-transparent window,
      // in CSS px from the window's left edge. The widget window is 312pt wide
      // but the orb cluster is right-aligned inside it, so a panel placed
      // against the WINDOW edge floats ~160pt away from anything visible —
      // the side panels place against this instead.
      if let left = payload["left"] as? Double, left.isFinite, left >= 0,
         abs((Bridge.widgetVisibleLeftCSS ?? -1000) - left) > 0.5 {
        Bridge.widgetVisibleLeftCSS = left
        delegate?.widgetBoundsChanged()
      }
      reply(webView, id, ["state": "ok"])
    case "status":
      fetchStatus { [weak self] data in self?.reply(webView, id, data) }
    case "setConnectorEnabled":
      // This webview-controlled write is deliberately limited to the passive
      // WhatsApp connector marker; no arbitrary path reaches the filesystem.
      let connector = payload["connector"] as? String ?? ""
      guard connector == "whatsapp" else {
        reply(webView, id, ["state": "error", "error": "unknown connector"])
        return
      }
      let marker = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".hazlie/connectors/\(connector).disabled")
      do {
        if payload["enabled"] as? Bool == true {
          if FileManager.default.fileExists(atPath: marker.path) { try FileManager.default.removeItem(at: marker) }
        } else {
          try Data().write(to: marker, options: .atomic)
          try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
        }
        Connectors.shared.start()
        reply(webView, id, ["state": "ok"])
      } catch {
        reply(webView, id, ["state": "error", "error": "could not update connector"])
      }
    case "bridgeStatus":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      bridgeCall("GET", "api/bridge", query: ["p": p]) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeBegin":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      beginBridgeLogin(p) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeDiscordServer":
      // Discord DMs are automatic; this narrowly scoped write toggles one
      // numeric guild ID from the server list returned by the local bridge.
      // Connect validates the ID again before it reaches mautrix-discord.
      let serverId = String((payload["serverId"] as? String ?? "").prefix(24))
      let enabled = payload["enabled"] as? Bool ?? false
      bridgeCall(
        "POST", "api/bridge/discord-server",
        json: ["p": "discord", "serverId": serverId, "enabled": enabled],
        timeout: 60
      ) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "googleAuth":
      // START THE GOOGLE SIGN-IN FROM THE TILE, with no terminal in the way.
      // The connect service spawns ops/gcal-auth.mjs, which listens on its own
      // loopback port for the callback. Native opens the returned authorization
      // URL in the default browser, as Google's OAuth policy requires.
      // Nothing sensitive crosses this bridge: the request carries only which
      // of two fixed flows to run, and the grant is written by that helper
      // straight into ~/.hazlie/secrets.
      let gf = String(payload["flow"] as? String ?? "google")
      // Which OAuth client signs this account in. The connect service checks
      // the name against its registry, so an unknown one is a 400 rather than
      // an argument reaching the helper's command line.
      let gc = String(payload["client"] as? String ?? "default")
      bridgeCall("POST", "api/google-auth", json: ["flow": gf, "client": gc], timeout: 15) { [weak self] d in
        guard let self else { return }
        // The service started the helper and handed back the URL. GoogleLogin
        // validates the fixed Google host and sends it to the system browser;
        // the helper receives the redirect and writes the token.
        if let url = d["url"] as? String, !url.isEmpty {
          DispatchQueue.main.async {
            GoogleLogin.present(url: url) { ok, why in
              // `ok` means macOS accepted the browser launch, not that consent
              // completed. Returning to the app fires the shelf's focus refresh;
              // the token file remains the source of truth. `why` is reserved
              // for a local validation or browser-launch failure.
              // AND THE SCRIM GETS OUT OF THE BROWSER'S WAY. The onboarding
              // panel is full-screen at .floating; a browser window is an
              // ordinary one, so Google's consent page opened UNDERNEATH a
              // scrim that swallowed every click on it. The only route to the
              // browser was Escape, which closes the flow. Seen live on the
              // clean-machine walk (2026-09-12): Dia opened behind and could
              // not be reached. Yielding on the launch macOS accepted, not on
              // consent, because consent is the thing that cannot be observed
              // from here.
              if ok { self.delegate?.yieldOnboardingToBrowser() }
              var out: [String: Any] = ["ok": ok, "opened": ok]
              if let why { out["refused"] = why }
              self.reply(webView, id, out)
            }
          }
        } else {
          self.reply(webView, id, d)
        }
      }
    case "importLinkedIn":
      // LINKEDIN WILL NOT LET ANYTHING READ YOUR CONNECTIONS, so the owner
      // asks LinkedIn for a copy and hands the file over. This is the whole
      // import: a file picker, a check, a copy.
      //
      // THE CHECK HAPPENS BEFORE THE COPY, and that ordering is the feature.
      // csvObjects parses these files by SCANNING for a header row containing
      // a known anchor column; with no anchor it yields nothing, the connector
      // records rows: 0 and ok: true, and the first-load screen then shows
      // linkedin at zero with nothing anywhere saying the file was unreadable.
      // A French export (Prénom/Nom) does exactly that. So the anchor is
      // checked here, on the picked file, and a file that fails is not copied
      // and is named back with its own first column quoted.
      //
      // "Is the anchor present anywhere in the first 4 KB", not "is it line
      // one": LinkedIn puts a Notes: paragraph above the real header and
      // csvObjects handles that fine, so a line-one check would reject files
      // that parse perfectly.
      //
      // AND THE FILE LINKEDIN ACTUALLY SENDS IS A ZIP. This used to refuse one
      // with a sentence telling the owner to unzip it themselves; it now takes
      // Connections.csv out of the archive and checks THAT, by exactly the same
      // rule. See extractConnections.
      importLinkedIn { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "googleProbe":
      // Whether the grant actually buys a READ, not whether a token file
      // exists. See connect/server.mjs — consent can complete and
      // messages.list still answer 403, and the token on disk cannot tell the
      // difference. Counts and HTTP statuses come back; no address, no message
      // id, no header, no snippet. 25s, because it is one live API call per
      // account and a 5s default would report a slow network as a failed grant.
      bridgeCall("GET", "api/google-probe", timeout: 25) { [weak self] d in
        self?.reply(webView, id, d)
      }

    case "connectSecret":
      let p = String(payload["p"] as? String ?? "")
      let value = String(payload["value"] as? String ?? "")
      bridgeCall("POST", "api/secret", json: ["p": p, "value": value], timeout: 10) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeCookies":
      let p = String((payload["p"] as? String ?? "").prefix(24))
      // The paste is passed through verbatim and deliberately not persisted,
      // logged, or echoed — the server masks it out of transcripts.
      let cookies = payload["cookies"] as? String ?? ""
      bridgeCall("POST", "api/bridge/cookies", json: ["p": p, "cookies": cookies], timeout: 15) { [weak self] d in
        self?.reply(webView, id, d)
      }
    case "bridgeWebLogin":
      // The mom-friendly path (BridgeLogin.swift): begin the login, open the
      // platform's REAL login page in an isolated in-app webview, harvest the
      // session cookies once the user is in, and hand them to the same cookies
      // endpoint. The webview and its cookies never touch this bridge's own
      // views; only the harvested set is POSTed to the loopback server.
      let p = String((payload["p"] as? String ?? "").prefix(24))
      // Fetch policy without beginning the Matrix-bot conversation. Beginning
      // used to happen first, which meant a fresh install with no bridge state
      // failed before the real Facebook/Instagram/X login window could even
      // appear. The login window needs only the static, server-authored policy;
      // start the bot immediately after cookies are available.
      bridgeCall("GET", "api/bridge", query: ["p": p]) { [weak self] begin in
        guard let self else { return }
        guard begin["state"] as? String == "ok",
              let loginUrl = begin["loginUrl"] as? String,
              let cookieDomain = begin["cookieDomain"] as? String
        else {
          self.reply(webView, id, begin) // begin failed → pass the notice back
          return
        }
        // ASK BEFORE THE PASSWORD, NOT AFTER.
        //
        // This route answers 200 even with no bridge stack behind it -- the GET
        // falls back to policy-only so a fresh install still renders -- so "ok"
        // used to mean "open the window". It did, on a machine with no
        // homeserver: the owner typed a real Meta password into a real Meta page,
        // the cookies were harvested, and beginBridgeLogin THEN discovered there
        // was nothing to hand them to and dropped the session. Nothing queued,
        // nothing resumed, and the next press was another fresh password.
        //
        // Only 'down' refuses. 'unknown' and 'up' both proceed, so an already
        // connected platform, or any route that never probed, behaves exactly as
        // it did. ensureBridgeRuntime still runs on the POST path below; this
        // only stops us collecting a credential we cannot deliver.
        if begin["engine"] as? String == "down" {
          self.reply(webView, id, ["state": "nobridge"])
          return
        }
        // The web-login policy comes from the server's platform table. A
        // platform with no host list cannot be linked this way at all — Discord
        // and Slack want a pasted token, Telegram a phone code — so say so and
        // let the page offer the manual path, instead of opening a window whose
        // first navigation the fence would cancel and whose cookie poll could
        // never fire. That blank window was the bug.
        let allowedHosts = (begin["allowedHosts"] as? [String])?.filter { !$0.isEmpty } ?? []
        let sessionCookie = begin["sessionCookie"] as? String ?? ""
        let requiredCookies = (begin["requiredCookies"] as? [String])?.filter { !$0.isEmpty } ?? []
        let cookieFormat = begin["cookieFormat"] as? String ?? "json"
        // The bridge's field contract, flattened to strings — the login window
        // fills it in without interpreting any of it.
        let fields: [[String: String]] = (begin["fields"] as? [[String: Any]] ?? []).map { f in
          var out: [String: String] = [:]
          for (k, v) in f { if let sv = v as? String { out[k] = sv } }
          return out
        }
        // A window needs a fence and SOMETHING to wait for. ~~That was read as
        // "a session cookie", which is only one of the two shapes~~ — Slack's
        // window harvests no session at all: it exists so the person can
        // answer the CAPTCHA Slack demands before it will email a code, and it
        // waits on the `fields` contract instead. Requiring a cookie here
        // meant Slack replied "manual" and no window ever opened, which is
        // exactly what the card kept showing (owner, 2026-08-26).
        let approval = begin["approval"] as? Bool ?? false
        let userAgent = String((begin["userAgent"] as? String ?? "").prefix(300))
        // How wide the login window has to be for THIS platform's page.
        // Server-authored like the rest; clamped because a fat-fingered or
        // hostile value must not open a window whose close button the owner
        // cannot reach. 0 keeps BridgeLogin's own default.
        let windowWidth = min(max(begin["windowWidth"] as? Int ?? 0, 0), 1400)
        // Subframe-only hosts: a challenge widget's iframes. Same server-authored
        // shape as allowedHosts, enforced separately — see BridgeLogin's fence.
        let allowedFrameHosts = (begin["allowedFrameHosts"] as? [String])?.filter { !$0.isEmpty } ?? []
        let browserHandoff = begin["browserHandoff"] as? Bool ?? true
        // Where a storage field's value lives, when signing in does not land
        // there. Server-authored like the rest; the window uses it at most once.
        let storageUrl = String((begin["storageUrl"] as? String ?? "").prefix(300))
        let label = begin["label"] as? String ?? p
        // ONE TILE PRESS, ONE NATIVE ACTION. The UI used to GET bridgeStatus
        // first to decide whether X had a live Chat-passcode question, then
        // send bridgeWebLogin as a second request. Focusing Settings rebuilds
        // its tile shelf, so that two-request handoff could strand the first
        // press on a detached row and leave only its spinner behind. This GET
        // already carries both policy and the server-authored current question:
        // resume it here, otherwise present the window below.
        if p == "twitter", let pending = self.xPasscodeQuestion(begin) {
          let submit = self.xPasscodeSubmit(initial: begin)
          DispatchQueue.main.async {
            BridgeLogin.presentPasscode(label: label, question: pending, submit: submit) { result in
              guard result == "connected" else {
                self.reply(webView, id, ["state": "cancelled"])
                return
              }
              self.bridgeCall("GET", "api/bridge", query: ["p": p]) { final in
                self.reply(webView, id, final)
              }
            }
          }
          return
        }
        if let pending = begin["pendingQuestion"] as? String, !pending.isEmpty {
          self.reply(webView, id, begin)
          return
        }
        // A QR LOGIN IS ALSO A WINDOW, just not a webview one. Discord has no
        // login page to drive — its bridge posts a remote-auth QR and waits
        // for the phone app — so it takes this branch before the webview
        // guard below, which would send it to the card's manual path.
        if begin["qrLogin"] as? Bool == true {
          self.presentQrLogin(webView, id: id, p: p, label: label)
          return
        }
        guard !allowedHosts.isEmpty, !sessionCookie.isEmpty || !fields.isEmpty || approval else {
          // No window for this platform — Telegram signs in by phone number
          // and a code, which is a conversation, not a page. The card runs it.
          //
          // ~~This branch ran `begin` itself, so one press opened on the bot's
          // first question~~ (d88e56c). Withdrawn the same day: `begin` sends
          // cancel-then-login, so a press on a tile whose login was ALREADY in
          // flight destroyed it — and each press put six command messages into
          // a sixteen-message transcript window, which scrolled the owner's own
          // answer out of sight and left the card unable to see that anything
          // had happened (owner, 2026-08-26: "i'm stuck here").
          //
          // The card begins the login instead, and it can do so safely because
          // it is the side that already parses whether the bot is mid-question.
          // One press still reaches the question; deciding here could not tell
          // "nothing started" from "something is waiting for an answer".
          self.reply(webView, id, ["state": "manual", "transcript": begin["transcript"] ?? []])
          return
        }
        DispatchQueue.main.async {
          let inlineX = p == "twitter"
          var afterHarvest: BridgeLogin.HarvestContinuation?
          if inlineX {
            afterHarvest = { cookiesJSON, login in
              self.beginBridgeLogin(p) { started in
                guard started["state"] as? String == "ok" else {
                  let message = started["error"] as? String ?? "couldn't start the local X connector"
                  DispatchQueue.main.async { login.showFailure(message) }
                  return
                }
                self.bridgeCall(
                  "POST", "api/bridge/cookies",
                  json: ["p": p, "cookies": cookiesJSON], timeout: 15
                ) { first in
                  self.awaitXBridgeStep(first) { next in
                    DispatchQueue.main.async {
                      if next["connected"] as? Bool == true {
                        login.completeInlineLogin()
                      } else if let question = self.xPasscodeQuestion(next) {
                        login.showPasscode(
                          question: question,
                          submit: self.xPasscodeSubmit(initial: next)
                        )
                      } else {
                        let message = next["error"] as? String
                          ?? "X didn't finish linking — close and try again"
                        login.showFailure(message)
                      }
                    }
                  }
                }
              }
            }
          }
          BridgeLogin.present(
            label: label, loginUrl: loginUrl, cookieDomain: cookieDomain,
            sessionCookie: sessionCookie, allowedHosts: allowedHosts,
            requiredCookies: requiredCookies, cookieFormat: cookieFormat,
            fields: fields, approval: approval, userAgent: userAgent,
            allowedFrameHosts: allowedFrameHosts, browserHandoff: browserHandoff,
            storageUrl: storageUrl,
            windowWidth: windowWidth,
            afterHarvest: afterHarvest
          ) { cookiesJSON in
            // THE HANDOFF SENTINEL, CHECKED BEFORE ANYTHING ELSE READS IT.
            //
            // The non-X path below POSTs any non-nil result verbatim to
            // /api/bridge/cookies, so an unguarded sentinel would be relayed into
            // the bridge bot as though it were a pasted credential blob. The
            // string is also chosen to be neither valid JSON nor a valid Cookie
            // header, so nothing downstream could mistake it for one either.
            //
            // It deliberately does NOT call beginBridgeLogin: begin's first act is
            // to cancel, and the connect page has its own Begin control. Not
            // calling it removes the hazard for every platform instead of fencing
            // one, which matters because Slack's challenge window is genuinely
            // mid-conversation.
            let handoff: () -> Void = {
              let opened = self.delegate?.openConnectRoot(
                path: .bridge, query: ["p": p]
              ) == true
              self.reply(webView, id, opened
                ? ["state": "browserLogin"]
                : ["state": "browserLogin",
                   "error": "the connect page isn't running — open Settings once, then retry"])
            }
            if cookiesJSON == BridgeLogin.browserHandoff { handoff(); return }
            if inlineX {
              guard cookiesJSON == "connected" else {
                self.reply(webView, id, ["state": "cancelled"])
                return
              }
              self.bridgeCall("GET", "api/bridge", query: ["p": p]) { final in
                self.reply(webView, id, final)
              }
              return
            }
            guard let cookiesJSON else {
              self.reply(webView, id, ["state": "cancelled"])
              return
            }
            // BEGIN FIRST, EXCEPT WHEN THE LOGIN IS ALREADY UNDERWAY. A cookie
            // harvest is self-contained: the window collects the session and
            // the conversation starts afterwards, which is why begin lives
            // here rather than before the window (a fresh install with no
            // bridge state used to fail before the window could appear).
            //
            // A CHALLENGE window is the opposite. It opens partway through a
            // conversation the bot is already holding — Slack asked for the
            // challenge because it had been given an email address — and
            // begin's first act is `cancel`. Calling it here would throw away
            // the very request whose answer this window just captured, and the
            // bot would then be asked for an email address with a captcha
            // token. Derived from the field contract, like the rest.
            let midConversation = fields.contains { $0["from"] == "captcha" }
            let sendValue = {
              self.bridgeCall(
                "POST", "api/bridge/cookies", json: ["p": p, "cookies": cookiesJSON], timeout: 15
              ) { done in
                self.reply(webView, id, done)
              }
            }
            if midConversation {
              sendValue()
            } else {
              self.beginBridgeLogin(p) { started in
                guard started["state"] as? String == "ok" else {
                  self.reply(webView, id, started)
                  return
                }
                sendValue()
              }
            }
          }
        }
      }
    // ---- setup: what onboarding needs to know and do ----------------------
    case "setupState":
      // Everything the setup scenes render from, in one round trip. Deliberately
      // says what IS rather than what SHOULD BE: the model is read off the
      // symlink, voice from the presence of the tree the ear actually loads, and
      // "is any data flowing" from hermes' own row count rather than from a
      // permission check. macOS gives no honest answer about Full Disk Access
      // from this process anyway — FDA attributes per resolved binary, and the
      // binary that matters is the node launchd spawns, not this app. The rows
      // are the probe, the same way each connector's run() is its own probe.
      let voiceDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".hazlie/models/voice/models")
      var state: [String: Any] = [
        "state": "ok",
        "voice": FileManager.default.fileExists(atPath: voiceDir.path),
        "downloading": ModelSetup.isDownloading,
      ]
      state["model"] = ModelSetup.installed?.id ?? ""
      // THE ROW COUNT IS OPT-IN, because it is the only slow thing in here.
      //
      // Everything above is local and instant -- a symlink read and two file
      // existence checks. The row count is an HTTP call to
      // hermes, which is single-threaded and blocks for the length of its boot
      // warm (12-20s measured), so this request times out at 4s and the WHOLE
      // reply waited for it. The old Settings model-size row made that delay
      // especially visible; the automatic selector no longer renders that row.
      //
      // Only the onboarding scenes read `rows`/`memory` -- they use it for "is any
      // data flowing yet". Settings never touches it and should never wait for it.
      guard payload["rows"] as? Bool == true else {
        reply(webView, id, state)
        return
      }
      rows { n, memory in
        var out = state
        out["rows"] = n
        if let memory { out["memory"] = memory }
        self.reply(webView, id, out)
      }

    case "activity":
      // Actual work owned by the app, never a guess based on a connector merely
      // being installed or enabled. The page polls this small local snapshot.
      var items: [[String: Any]] = []
      if let model = ModelSetup.activity { items.append(model) }
      if let label = automaticModelWorkLabel {
        items.append(["kind": "model", "label": label])
      }
      items.append(contentsOf: Connectors.shared.activityItems)
      if let label = Distiller.shared.activity {
        items.append(["kind": "index", "label": label])
      }
      // WHETHER THE THING THAT DOES THE WORK IS EVEN UP. An empty item list
      // means "nothing in flight", which is the same picture for a reader that
      // has finished, one that has not started and one that died — and the
      // panel had no way to tell the owner which. The onboarding screen has
      // always known (it reads the run log); settings gets the fact directly
      // from the child process this app owns.
      var activity: [String: Any] = [
        "state": "ok", "items": items, "reading": Connectors.shared.isRunning,
      ]
      if let estimate = Connectors.shared.activityEstimate {
        activity["estimate"] = estimate
      }
      reply(webView, id, activity)

    case "workStatus":
      // A sleeping orb means no work is ACTUALLY underway. Scheduled queue
      // entries intentionally do not participate here: they belong in
      // Settings, not on the ambient desktop control.
      let workLabel: String?
      // Remembered, because the connector-queue horizon may only be attached to
      // a connector label — see below.
      let interactive = Bridge.activeWork.label != nil
      if let label = Bridge.activeWork.label {
        workLabel = label
      } else if let model = ModelSetup.activity,
                let phase = model["phase"] as? String,
                let tier = model["tier"] as? String {
        workLabel = "\(phase) the \(tier) local model"
      } else if let label = automaticModelWorkLabel {
        workLabel = label
      } else if let label = Connectors.shared.activeWorkLabel {
        workLabel = label
      } else if let label = Distiller.shared.activity {
        workLabel = label
      } else if let label = Connectors.shared.queuedWorkLabel {
        // A waiting connector slice is still part of the same total-hours job
        // shown in Settings. Falling through to idle here made the flywheel
        // alternate with sleep between every source.
        workLabel = label
      } else {
        workLabel = nil
      }
      if let workLabel {
        KeepMacAwake.update(processing: true)
        var status: [String: Any] = ["state": "working", "label": workLabel]
        // THE HORIZON BELONGS TO THE CONNECTOR QUEUE, so it may only ride a
        // connector label.
        //
        // ~~"Interactive work can temporarily outrank a connector label while
        // the total remains useful."~~ It is not useful there, it is wrong:
        // asking the orb a question during a calendar backfill rendered
        // "current: thinking about your question" above a queue duration, which
        // reads as a duration for the question.
        //
        // And when the daemon publishes no estimate — now the normal case, since
        // matrix backfill publishes a COUNT of conversations rather than a floor
        // dressed as a forecast — pass that count instead, so the orb can say
        // something true rather than promise a number that never arrives.
        if !interactive {
          if let estimate = Connectors.shared.activityEstimate {
            status["estimate"] = estimate
          }
          if let rooms = Connectors.shared.activityBackfillRooms, rooms > 0 {
            status["backfillRooms"] = rooms
          }
        }
        reply(webView, id, status)
      } else {
        KeepMacAwake.update(processing: false)
        reply(webView, id, ["state": "idle"])
      }

    // Relationship Memory (L5 step 10): the orb's reconnect card. Thin bearer
    // proxies to hermes -- the page never holds the token, and the card
    // payload crosses as data the page renders with textContent only.
    case "relCard":
      // SPENT, NOT READ. See openReconnect: the widening is for the pull that
      // follows the hand-off and for nothing after it, so taking it here is what
      // makes "just this once" true.
      var cardPath = "admin/relationship/card"
      if let mode = pendingOneOffMode {
        cardPath += "?mode=\(mode)"
        pendingOneOffMode = nil
      }
      relHermes("GET", cardPath, json: nil) { [weak self] out in
        self?.reply(webView, id, out)
      }

    // A PEEK, NOT A SERVE. The widget's own 10-minute poll asks only whether
    // a card is waiting and what it would tease. GET /card records 'shown',
    // spends a global-cap slot, starts that person's 7-day pool cooldown and
    // flips the two producers' turn -- all four for a card no human has
    // looked at, on every poll, forever. ?peek=1 answers the tease and
    // records nothing; only the reconnect panel's own pull serves.
    case "relCardPeek":
      // AN OPTIONAL ONE-OFF MODE, and nothing durable behind it. The route reads
      // `mode` as askedMode: it wins for THIS request only, produces and serves
      // under it, and never touches relationshipMemory.mode. That is what lets
      // screen 6 offer a first card outside the owner's pick without quietly
      // rewriting the pick. Validated against the same list the picker offers,
      // so a page cannot ask for a mode hermes would have to reject.
      var peekPath = "admin/relationship/card?peek=1"
      if let mode = payload["mode"] as? String, Bridge.relationshipModes.contains(mode) {
        peekPath += "&mode=\(mode)"
      }
      relHermes("GET", peekPath, json: nil) { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "relRefresh":
      // "mode" is the only field the widget's mode picker sends; an absent
      // or unrecognized value falls through to hermes' own config default
      // (relationshipMemory.mode ?? 'any'), so no allowlist beyond the one
      // key is needed here.
      var refreshBody: [String: Any] = [:]
      if let mode = payload["mode"] { refreshBody["mode"] = mode }
      relHermes("POST", "admin/relationship/refresh", json: refreshBody) { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "onboardingProgress":
      // Screen 6's live table. Counts and projection state only -- see the
      // route. Polled every 3s while the screen is up, which is why it must
      // stay a read of already-computed numbers and never trigger a rebuild.
      relHermes("GET", "admin/onboarding/progress", json: nil) { [weak self] out in
        // AND WHY THE READER IS NOT RUNNING, when this app already knows.
        //
        // hazlie-tree-perms is FATAL in the daemon and says so only in the
        // daemon's own log. Connectors.reassertTreePerms tries to satisfy it at
        // every start and cannot for three shapes -- a symlinked directory, a
        // path that is not a directory, a directory owned by root -- so the
        // owner watches this screen wait for rows that will never come. The
        // paths ride along with the table that is doing the waiting.
        var body = out
        let blockers = Connectors.shared.treePermsBlockers
        if !blockers.isEmpty { body["treePermsBlockers"] = blockers }
        self?.reply(webView, id, body)
      }

    case "cardConfig":
      // The settings panel's one question for the reader: what is the daily
      // card set to. Bearer-only and read-only on the hermes side; nothing here
      // sends a body, so the page cannot write a setting through this door.
      relHermes("GET", "admin/config/card", json: nil) { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "setEngine":
      // The page sends one of two words and nothing else; hermes checks it
      // against its own closed list and owner.mjs does the write. Anything
      // this bridge does not recognise never reaches the route, so a page
      // cannot even attempt to name a third engine.
      let askedEngine = String(payload["engine"] as? String ?? "")
      guard ["claude-cli", "local"].contains(askedEngine) else {
        reply(webView, id, ["state": "error", "error": "unknown engine"])
        return
      }
      relHermes("POST", "admin/config/engine", json: ["engine": askedEngine]) { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "relMode":
      var modeBody: [String: Any] = [:]
      for k in ["mode"] {
        if let v = payload[k] { modeBody[k] = v }
      }
      // WRITTEN DOWN BEFORE IT IS SENT. See cardModePending: a press is the
      // decision and the POST is only how it travels, so a hermes that cannot
      // keep it today must not cost the owner their pick.
      // VALIDATED BEFORE IT IS REMEMBERED. The pending value is re-delivered at
      // every launch until hermes answers persisted:true, so a mode hermes will
      // never accept is a full retry ladder on every launch, for ever, with
      // nothing recording that it has already failed a hundred times. The page
      // only offers these three today; that is a reason to write the list down,
      // not a reason to trust the payload.
      if let mode = payload["mode"] as? String, Bridge.relationshipModes.contains(mode) {
        Bridge.cardModePending = mode
        Bridge.cardModeLaunches = 0
      }
      relHermes("POST", "admin/relationship/mode", json: modeBody) { [weak self] out in
        if out["persisted"] as? Bool == true { Bridge.cardModePending = nil }
        self?.reply(webView, id, out)
      }

    case "relDraft":
      var draftBody: [String: Any] = [:]
      for k in ["snapshot_id"] {
        if let v = payload[k] { draftBody[k] = v }
      }
      relHermes("POST", "admin/relationship/draft", json: draftBody) { [weak self] out in
        self?.reply(webView, id, out)
      }

    case "relEvent":
      var evt: [String: Any] = [:]
      // "note" is the owner's free-text why -- the field the whole feedback
      // loop exists to capture; the audit found this allowlist silently
      // dropping it while every other layer handled it.
      for k in ["snapshot_id", "person_key", "event", "reason", "note", "mute_days"] {
        if let v = payload[k] { evt[k] = v }
      }
      relHermes("POST", "admin/relationship/event", json: evt) { [weak self] out in
        // A judgment changes what the orb should show right now -- poke the
        // widget rather than let it wait out the poll interval. AFTER the
        // reply, not before it: firing this first raced the POST, so the
        // widget's re-read reached hermes while the verdict was still in
        // flight, got the same unjudged card back, and left the badge lit
        // with the person the owner had just judged.
        self?.delegate?.relCardChanged()
        self?.reply(webView, id, out)
      }

    case "modelDownload":
      // Hardware owns model quality. Performance mode only changes concurrency,
      // so no page gets to smuggle a manual tier choice back into this path.
      let tier = ModelSetup.recommended
      let finishSetup: () -> Void = { [weak self] in
        guard let self else { return }
        self.delegate?.setupProgress(["phase": "installing", "tier": tier])
        DispatchQueue.global(qos: .utility).async {
          guard Provision.ensureLlamaRuntime() else {
            self.delegate?.setupProgress([
              "phase": "failed", "tier": tier,
              "error": "the model is saved, but the engine that runs it is missing",
            ])
            return
          }
          Provision.installAgent("io.intaglio.llama-server")
          Provision.installAgent("io.intaglio.hermes")
          if Provision.waitForLlama() {
            ModelSetup.markAutomaticSelectionCurrent()
            self.delegate?.setupProgress(["phase": "ready", "tier": tier])
            ModelSetup.notify(
              title: "Intaglio Labs can answer now",
              body: "The models finished downloading and are ready.")
          } else {
            let why = "The model is saved but didn’t start. Reopen the app to try again."
            self.delegate?.setupProgress([
              "phase": "failed", "tier": tier, "error": why,
            ])
            ModelSetup.notify(title: "Setup didn’t finish", body: why)
          }
        }
      }
      ModelSetup.download(
        tierId: tier,
        progress: { [weak self] got, total in
          self?.delegate?.setupProgress([
            "phase": "downloading", "got": got, "total": total, "tier": tier,
          ])
        },
        done: { [weak self] failure in
          guard let self else { return }
          if let failure {
            self.delegate?.setupProgress(["phase": "failed", "error": failure, "tier": tier])
            if failure != "cancelled" {
              ModelSetup.notify(title: "Setup didn’t finish", body: failure)
            }
            return
          }
          finishSetup()
        }
      )
      reply(webView, id, ["state": "ok"])

    case "modelCancel":
      ModelSetup.cancel()
      reply(webView, id, ["state": "ok"])

    case "engineProbe":
      // ASKS THE CLIENT, DOES NOT ASK THE FILESYSTEM. See EngineProbe.swift:
      // "the binary resolves" is not the same question as "the binary works",
      // and only the second one may be allowed to offer a switch that sends
      // message excerpts off this Mac. The reply carries the configured engine
      // as well, so the toggle renders from the config file rather than from a
      // default that would read as an opt-out the owner never made.
      EngineProbe.run { [weak self] out in
        var result = out
        if result["state"] == nil { result["state"] = "error" }
        self?.reply(webView, id, result)
      }

    case "onboardingStep":
      // Fire-and-forget from showScreen(). Bounded because it is a UserDefaults
      // key written from a webview message, and an unbounded string there is a
      // disk write the page controls the size of.
      if let step = payload["step"] as? String, step.count <= 16 {
        Bridge.onboardingStep = step
      }
      reply(webView, id, ["state": "ok"])

    case "openFullDiskAccess":
      // Touch a protected path FIRST, then open the pane. macOS lists an app
      // under Full Disk Access once it has attempted a protected read, so the
      // failed attempt is what puts "intaglio labs" in the list with a switch
      // already waiting. Without it the owner has to press +, walk a file
      // picker to Applications, and find the app themselves — which is the
      // copy-paste problem wearing different clothes.
      // Get the scrim out of the way FIRST. It is full-screen at .floating, so
      // System Settings — an ordinary level-0 window — came up UNDERNEATH it:
      // "opens in the background with no way to get to it", and the step got
      // skipped, and Messages and Notes then read nothing.
      delegate?.yieldForSettings(true)
      Permissions.primeFullDisk()
      // And the part Settings will not do: the app, on screen, draggable onto
      // the list. See FullDiskHelper.
      FullDiskHelper.shared.begin { [weak self] in
        self?.delegate?.yieldForSettings(false)
      }
      reply(webView, id, ["state": "ok"])

    case "startSources":
      // WHETHER IT ACTUALLY CAME UP, not whether a config file exists.
      // Connectors.start() returns silently on six guards, two of which
      // (a stop latch, a model download holding the reader) are states the
      // settings panel's "start it" button can land in — and it used to report
      // success for every one of them, so the row said "starting…" for ever.
      let started = startReadingSources()
      reply(webView, id, [
        "state": started.configWritten ? "ok" : "error",
        "reading": started.outcome.isUp,
        "why": started.outcome.rawValue,
      ])

    case "linkedInState":
      // WHAT IS ALREADY HERE, so a second run of the flow does not ask for a
      // file it has. Counts and a date; see linkedInState().
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        guard let self else { return }
        self.reply(webView, id, self.linkedInState())
      }

    case "permissionState":
      // NO DIAGNOSTIC ON THE POLL PATH. This screen polls while it is up, and
      // writeDiagnostic() evaluates Permissions.all a second time and writes a
      // JSON file — so a 1.5s poll was four chat.db opens, a createDirectory
      // and a file write every tick, forever, and on a denied machine four
      // tccd denial events with it. The FDA row is primed by the FIRST
      // attempt; the rest bought nothing. The page asks for the diagnostic on
      // entry and after a request, which is when somebody is actually going to
      // read the file.
      let permissions = Permissions.all
      let deepCheck = payload["diagnostic"] as? Bool == true
      if deepCheck { Permissions.writeDiagnostic(mapped: permissions) }
      // WHICH APP THE GRANT WOULD LAND ON — AND ONLY WHEN THAT IS A REAL
      // QUESTION ON THIS MAC.
      //
      // The 30 August rename left com.hazlie.widget allowed in Full Disk
      // Access and io.intaglio.widget denied. fullDisk() probes from THIS
      // process, so it reported denied correctly — but the owner was looking
      // at a Settings list holding a row labelled "intaglio labs" with its
      // switch ON, and the screen stayed red with nothing to explain the
      // contradiction. So the screen named the identifier.
      //
      // It named it to EVERYONE, including the great majority who have never
      // had a pre-rename install — a bundle identifier on the second screen of
      // a consumer flow, explaining a developer's problem. `staleBundle` is the
      // probe's answer instead: present only when this process cannot read AND
      // this Mac carries the marks of an install from before the rename. The
      // page says nothing unless it is there. `bundle` stays on the reply for
      // the sentence to name and for the diagnostic to keep recording.
      var permReply: [String: Any] = [
        "state": "ok",
        "permissions": permissions,
        "bundle": Bundle.main.bundleIdentifier ?? "?",
      ]
      // ON THE SAME PATH AS THE DIAGNOSTIC, AND FOR THE SAME REASON. The screen
      // polls while it is up; staleGrantBundle is two directory reads and two
      // stats, and the machine it runs on is by definition the one where the
      // poll is already costing tccd denials. The page asks for the deep check
      // on entry and after a permission request, which is when the answer can
      // have changed, and `staleChecked` tells it which kind of reply this is
      // so a poll cannot rub out the line an entry drew.
      permReply["staleChecked"] = deepCheck
      if deepCheck,
         let stale = Permissions.staleGrantBundle(disk: Permissions.fullDiskStatus(mapped: permissions)) {
        permReply["staleBundle"] = stale
      }
      reply(webView, id, permReply)

    case "requestPermission":
      // A real system prompt, in context, naming this app. macOS shows it once
      // per app per permission and remembers a refusal, so a second press does
      // nothing — the page reads the returned status and offers Settings when
      // it comes back denied.
      let which = String((payload["which"] as? String ?? "").prefix(16))
      // The scrim is full-screen and above ordinary windows; a TCC prompt is an
      // ordinary window. Drop out of its way, or it opens underneath and the
      // owner refuses something they never saw.
      delegate?.yieldForPrompt(true)
      Permissions.request(which) { [weak self] status in
        guard let self else { return }
        self.delegate?.yieldForPrompt(false)
        // Granted mid-flow means the reader can suddenly see more; nudge it so
        // the owner does not wait for the next poll to see anything happen.
        if status == .granted { Connectors.shared.start() }
        // The one moment the raw authorization values are worth a file: a
        // prompt was just displayed (or declined to display) and this is what
        // each API answered afterwards.
        Permissions.writeDiagnostic()
        self.reply(webView, id, ["state": "ok", "which": which, "status": status.rawValue])
      }

    case "ask":
      let utterance = String((payload["utterance"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
      // The voice turn is the ask carrying the transcript's exact text.
      // Consume it only on a match: a non-matching ask may be a load-time
      // message queued AHEAD of the transcript, whose own ask is still
      // coming — clearing here would silence it. Typed messages clear the
      // transcript at openChatWith instead.
      let voiceTurn = pendingVoiceUtterance == utterance
      if voiceTurn { pendingVoiceUtterance = nil }
      ask(utterance) { [weak self] data in
        guard let self else { return }
        // AN ABSTENTION IS NOT ALWAYS THE SAME ANSWER.
        //
        // "nothing in what i've got covers that" means one thing when the memory
        // has read everything and quite another while it is still reading — and
        // the second is the case somebody hits right after connecting, when the
        // app looks broken rather than busy. So a sourceless answer carries the
        // reading state with it and the page can say which one this is.
        //
        // Attached HERE rather than in hermes' answer, whose shape is exactly
        // {text, sources, usedRows} and is pinned by a contract test. Costs a
        // loopback GET, and only when the answer came back empty-handed.
        //
        // TWO REPLY PATHS, so everything that has to happen once per settled ask
        // happens on both of them: speaking a voice turn, and handing the page
        // the next queued message. Neither may sit after this closure's last
        // statement — the guard below returns, and the enrichment path replies
        // from a nested callback long after that line would have run.
        let sourceless = (data["sources"] as? [Any])?.isEmpty ?? true
        guard sourceless, data["state"] as? String == "ok" else {
          self.reply(webView, id, data)
          self.speakIfVoiceTurn(data, voiceTurn: voiceTurn)
          self.deliverNextQueued(to: webView)
          return
        }
        // Two questions on an empty answer, and they are different questions:
        // /stats says whether the memory is still READING, and suggest says whether
        // something already read would have answered this if anyone had confirmed
        // it. The second is the one worth acting on, so it wins when both are true.
        self.rows { _, memory in
          self.suggestion(for: utterance) { claim in
            var out = data
            if let memory { out["memory"] = memory }
            if let claim { out["confirm"] = claim }
            self.reply(webView, id, out)
            self.speakIfVoiceTurn(out, voiceTurn: voiceTurn)
            // This ask settled; if a load-time message is queued behind it,
            // hand the page the next one as its OWN ask. After the reply, never
            // before it: reply()'s evaluateJavaScript is what resolves the ask's
            // promise and drops chat.js's busy flag, and a message handed over
            // while that flag is still set is dropped on the floor.
            self.deliverNextQueued(to: webView)
          }
        }
      }
    case "decideClaim":
      // Accept or reject ONE claim, from the chat bubble that raised it. The
      // owner is the actor on the record either way — nothing here decides
      // anything on its own, it only carries a press to hermes.
      let claimId = payload["id"] as? Int ?? -1
      let action = String((payload["action"] as? String ?? "").prefix(8))
      guard claimId > 0, action == "accept" || action == "reject" else {
        reply(webView, id, ["state": "error", "error": "bad decision"])
        break
      }
      guard let tok = bearerToken() else {
        reply(webView, id, ["state": "error", "error": "no token"])
        break
      }
      let dreq = request("POST", hermesBase, "admin/memory/decide", bearer: tok,
                         json: ["claim_id": claimId, "action": action], timeout: 6)
      URLSession.shared.dataTask(with: dreq) { [weak self] _, response, _ in
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        DispatchQueue.main.async {
          self?.reply(webView, id, ["state": ok ? "ok" : "error"])
        }
      }.resume()
    case "frontierSend":
      // THIS IS THE CONSENT BOUNDARY. chat.js sends the value of the visible,
      // editable textarea only after the owner presses the provider-named send
      // button. The wire shape is exactly {provider, prompt} and anything else
      // is refused outright — a denylist of suspicious names was proven
      // bypassable by a field called "notes" in review (2026-08-31), so the
      // guard is on the whole key set, not on names someone thought of.
      guard payload.keys.allSatisfy({ $0 == "provider" || $0 == "prompt" }) else {
        reply(webView, id, ["state": "error", "error": "bad frontier request"])
        break
      }
      let providerName = String((payload["provider"] as? String ?? "").prefix(16))
      let prompt = String((payload["prompt"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(12_000))
      guard let provider = FrontierProvider(rawValue: providerName), !prompt.isEmpty else {
        reply(webView, id, ["state": "error", "error": "bad frontier request"])
        break
      }
      let work = Bridge.activeWork.begin("waiting for \(providerName)")
      FrontierRunner.shared.run(provider: provider, prompt: prompt) { [weak self] result in
        Bridge.activeWork.finish(work)
        self?.reply(webView, id, result)
      }
    case "frontierCancel":
      // Two cancel verbs on purpose. The shared "cancel" briefly cancelled the
      // frontier job too, so cancelling a slow local ask silently discarded a
      // frontier answer that was already sent and billed — and vice versa
      // (review 2026-08-31). Each pending bubble cancels only its own job.
      FrontierRunner.shared.cancel()
      reply(webView, id, ["state": "ok"])
    case "cancel":
      askTask?.cancel()
      reply(webView, id, ["state": "ok"])
    case "openExternal":
      let urlString = payload["url"] as? String ?? ""
      if allowedExternal.contains(urlString), let url = URL(string: urlString) {
        NSWorkspace.shared.open(url)
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "url not in allowlist"])
      }
    case "openProfile":
      // THE ONE EXTERNAL URL THAT CANNOT BE ON A FIXED ALLOWLIST: a person's own
      // LinkedIn profile, which came out of the owner's own export and is
      // different for every card. `openExternal` above is a set of literal
      // strings and must stay that way — this is a separate, narrower door with
      // the host pinned instead of the whole string.
      //
      // https only, linkedin.com or www.linkedin.com only, and a /in/ path
      // only: that is the shape graph.mjs stores, and anything else is either a
      // corrupted row or a page asking for something it was not given.
      // LENGTH IS A REFUSAL, NOT A TRIM. ~~prefix(300)~~ truncated before
      // parsing, so an over-long row opened a silently different path.
      let asked = payload["url"] as? String ?? ""
      guard asked.count <= 300,
            let parsed = URL(string: asked), parsed.scheme == "https",
            let host = parsed.host?.lowercased(),
            host == "linkedin.com" || host == "www.linkedin.com",
            parsed.path.hasPrefix("/in/"),
            var rebuilt = URLComponents(url: parsed, resolvingAgainstBaseURL: false)
      else {
        reply(webView, id, ["state": "error", "error": "not a linkedin profile"])
        return
      }
      // REBUILT FROM ITS PARTS, not opened as written. The export row carries a
      // ?trk= tracking parameter, which is this app handing LinkedIn a referrer
      // for a click the owner made privately — and rebuilding also removes the
      // whole class of disagreement between Foundation's parser and the
      // browser's about exotic inputs. Scheme, host, path; nothing else.
      rebuilt.query = nil
      rebuilt.fragment = nil
      rebuilt.user = nil
      rebuilt.password = nil
      rebuilt.port = nil
      guard let profile = rebuilt.url else {
        reply(webView, id, ["state": "error", "error": "not a linkedin profile"])
        return
      }
      NSWorkspace.shared.open(profile)
      reply(webView, id, ["state": "ok"])

    case "openLinkedInExport":
      // "REQUEST A COPY" — AND THE PAGE DOES NOT GET TO SAY WHERE.
      //
      // Onboarding screen 4 sends the owner to LinkedIn's data-download page.
      // Unlike openProfile there is nothing per-person about that address, so
      // the payload carries no url at all and this case reads the constant:
      // openProfile pins a HOST because its path comes out of the owner's own
      // export, and this pins the whole STRING because there is only ever one.
      //
      // openExternal would do the same job and is deliberately not used. It is
      // granted to connections and people, and giving onboarding a verb that
      // opens anything on a shared allowlist widens the surface of the one page
      // that runs before the owner has agreed to anything. This door opens one
      // page, and the guard below is what keeps it the page in the allowlist.
      guard allowedExternal.contains(Bridge.linkedInExportPage),
            let exportPage = URL(string: Bridge.linkedInExportPage)
      else {
        reply(webView, id, ["state": "error", "error": "no linkedin export page"])
        return
      }
      let openedExport = NSWorkspace.shared.open(exportPage)
      // AND THE SCRIM GETS OUT OF THE BROWSER'S WAY, exactly as googleAuth does
      // and for exactly the same reason: the onboarding panel is full-screen at
      // .floating, a browser window is an ordinary one, and without this the
      // page the owner was just sent to opens UNDERNEATH a scrim that swallows
      // every click on it. See yieldOnboardingToBrowser.
      //
      // Gated on the launch macOS accepted. Lowering the scrim for a browser
      // that never opened would leave the flow sitting behind every other window
      // with nothing to come back from.
      if openedExport { delegate?.yieldOnboardingToBrowser() }
      reply(webView, id, ["state": openedExport ? "ok" : "error", "opened": openedExport])

    case "openApp":
      let bundleId = String((payload["bundleId"] as? String ?? "").prefix(96))
      guard allowedApps.contains(bundleId),
            let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
      else {
        reply(webView, id, ["state": "notInstalled"])
        return
      }
      let config = NSWorkspace.OpenConfiguration()
      config.activates = true
      NSWorkspace.shared.openApplication(at: appURL, configuration: config) { [weak self] _, error in
        DispatchQueue.main.async {
          self?.reply(webView, id, error == nil ? ["state": "ok"] : ["state": "notInstalled"])
        }
      }
    case "openConnectLink":
      // The cloud-connector setup door: the connect page's ROOT, in the
      // browser — a full setup flow (tokens, app passwords) that wants a real
      // browser.
      if delegate?.openConnectRoot(path: .root, query: [:]) == true {
        reply(webView, id, ["state": "ok"])
      } else {
        reply(webView, id, ["state": "error", "error": "no connect link yet"])
      }
    case "initSearch":
      let days = (payload["days"] as? Int) ?? Int(payload["days"] as? Double ?? 365)
      peopleCall("POST", "people/init", json: ["days": days]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleReview":
      let days = (payload["days"] as? Int) ?? Int(payload["days"] as? Double ?? 365)
      let limit = (payload["limit"] as? Int) ?? Int(payload["limit"] as? Double ?? 20)
      peopleCall("GET", "people/review?days=\(days)&limit=\(limit)", json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleDecide":
      let a = String(payload["a"] as? String ?? "")
      let b = String(payload["b"] as? String ?? "")
      let verdict = String(payload["verdict"] as? String ?? "")
      peopleCall("POST", "people/decide", json: ["a": a, "b": b, "verdict": verdict]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleSelf":
      // Explicitly identify a graph card as the owner. The server verifies the
      // key exists in the local graph before it writes the local-only config.
      let key = String(payload["key"] as? String ?? "")
      peopleCall("POST", "people/self", json: ["key": String(key.prefix(300))]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleRole":
      let key = String(payload["key"] as? String ?? "")
      let role = String(payload["role"] as? String ?? "")
      let year = (payload["year"] as? Int) ?? Int(payload["year"] as? Double ?? 0)
      var rolePayload: [String: Any] = ["key": String(key.prefix(300)), "role": role]
      if year > 0 { rolePayload["year"] = year }
      peopleCall("POST", "people/role", json: rolePayload) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleYear":
      // The timeline view: one year of people with the year's topics. Absent
      // year = server default (the current year).
      let year = (payload["year"] as? Int) ?? Int(payload["year"] as? Double ?? 0)
      // A refresh the reader asked for: the server rebuilds before answering.
      let wantsRebuild = payload["rebuild"] as? Bool == true
      // Role-label navigation promises everybody with that label in this
      // particular year, not only the normal quick-paint top 250.
      let wantsAll = payload["all"] as? Bool == true
      let yBase = year > 0 ? "people/year?year=\(year)" : "people/year?"
      let yPath = yBase
        + (wantsRebuild ? "&rebuild=1" : "")
        + (wantsAll ? "&all=1" : "")
      peopleCall("GET", yPath, json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }
    case "peopleFind":
      // Search across every year, ranked by hermes. The page used to filter the
      // open year's already-loaded list, which could not reach a person in
      // another year or past the 250 that list holds.
      let fq = String(String(payload["q"] as? String ?? "").prefix(100))
      let esc = fq.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
      peopleCall("GET", "people/find?q=\(esc)", json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }

    case "peopleMap":
      // Every person across every year, with per-year topics and NO row cap —
      // which is why the constellation reads from here rather than summing the
      // year payloads: those are capped per year, and a sum of capped pages
      // would print topic counts that are quietly short.
      peopleCall("GET", "people/map?for=page" + ((payload["rebuild"] as? Bool == true) ? "&rebuild=1" : ""), json: nil) { [weak self] data in
        self?.reply(webView, id, data)
      }

    case "monthsView":
      // Both directions on one verb: a payload with "state" saves, a bare call
      // reads. Bounded for the same reason onboardingStep is — this is a
      // UserDefaults write driven by a webview message, and an unbounded string
      // there is a disk write whose size the page chooses.
      if let s = payload["state"] as? String {
        Bridge.monthsView = s.count <= 120 ? s : nil
      }
      reply(webView, id, ["state": Bridge.monthsView ?? ""])

    case "peopleAvatars":
      let keys = (payload["keys"] as? [String])?.prefix(400).map { String($0.prefix(200)) } ?? []
      peopleCall("POST", "people/avatars", json: ["keys": Array(keys)]) { [weak self] data in
        self?.reply(webView, id, data)
      }
    default:
      reply(webView, id, ["state": "error", "error": "unknown message type"])
    }
  }

  // Shared passthrough for the /people/* endpoints: bearer + the same exact
  // /health identity check ask() uses, then reply the server's JSON verbatim.
  /// HERMES IS COMING UP, NOT BROKEN.
  ///
  /// widget/build.sh restarts hermes and this app together, so the app's very
  /// first request routinely lands before hermes is listening. Both the identity
  /// probe and the request itself then fail on connection refused, and both were
  /// terminal — the page rendered "couldn't load 2026" on essentially every first
  /// launch, which is what the owner reported seeing "every time".
  ///
  /// Retried with a backoff, and ONLY for the two states that mean "not up yet".
  /// An auth failure, a 404 or an HTTP error are answers, not silence, and
  /// retrying them would turn a clear message into a slow one.
  private static let transientStates: Set<String> = ["down", "identity"]
  /// Sized against the thing that actually blocks: hermes is single-threaded, and
  /// a cold /people/year can take seconds of SYNCHRONOUS work. While
  /// that runs the process cannot answer anything at all — so a second request's
  /// identity probe times out and reports "identity", meaning "not the hermes I
  /// trust", when the truth is "busy". Every panel open fires several calls, so
  /// this was not a rare race; it was the common case.
  ///
  /// The budget therefore has to outlast a cold build plus queueing, not just a
  /// process launch. The longer retry budget costs nothing when
  /// hermes is warm because the first attempt succeeds.
  private static let retryDelays: [Double] = [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0]

  private func peopleCall(
    _ method: String, _ path: String, json: [String: Any]?,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    peopleCallAttempt(method, path, json: json, attempt: 0, done)
  }

  private func peopleCallAttempt(
    _ method: String, _ path: String, json: [String: Any]?,
    attempt: Int, _ done: @escaping ([String: Any]) -> Void
  ) {
    peopleCallOnce(method, path, json: json) { [weak self] result in
      let state = result["state"] as? String
      guard let self,
            let state, Bridge.transientStates.contains(state),
            attempt < Bridge.retryDelays.count
      else { done(result); return }
      // Only the transient pair reaches here, so this cannot mask a real answer.
      DispatchQueue.main.asyncAfter(deadline: .now() + Bridge.retryDelays[attempt]) {
        self.peopleCallAttempt(method, path, json: json, attempt: attempt + 1, done)
      }
    }
  }

  private func peopleCallOnce(
    _ method: String, _ path: String, json: [String: Any]?,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    checkHermesIdentity { [weak self] identityOK in
      guard let self else { return }
      guard identityOK else { done(["state": "identity"]); return }
      let req = self.request(method, self.hermesBase, path, bearer: tok, json: json, timeout: 30)
      self.session.dataTask(with: req) { data, resp, err in
        guard err == nil, let http = resp as? HTTPURLResponse else {
          done(["state": "down"]); return
        }
        switch http.statusCode {
        case 200:
          if let d = data,
             let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            done(obj)
          } else {
            done(["state": "error", "error": "unparseable"])
          }
        case 401, 403: done(["state": "auth"])
        case 404: done(["state": "notready"])
        default: done(["state": "error", "error": "http \(http.statusCode)"])
        }
      }.resume()
    }
  }

  /// A JS string literal for a value this app produced. JSONSerialization does
  /// the escaping, so a path with a quote or a newline in it cannot end the
  /// literal early — the same helper main.swift keeps for its own pushes.
  static func jsString(_ s: String) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: [s]),
          let arr = String(data: d, encoding: .utf8) else { return "\"\"" }
    return "\(arr)[0]"
  }

  private func reply(_ webView: WKWebView, _ id: Int, _ data: [String: Any]) {
    let envelope: [String: Any] = ["id": id, "ok": true, "data": data]
    guard JSONSerialization.isValidJSONObject(envelope),
          let json = try? JSONSerialization.data(withJSONObject: envelope),
          let s = String(data: json, encoding: .utf8)
    else { return }
    DispatchQueue.main.async {
      webView.evaluateJavaScript("window.__hzDispatch(\(s))", completionHandler: nil)
    }
  }

  // MARK: setup helpers

  /// Speak the answer if this turn began with the voice. Pulled out of the ask
  /// handler when that grew a second reply path: the two must not be able to
  /// disagree about whether the turn was spoken.
  ///
  /// The provenance is PASSED IN, not read from a stored flag. A process-global
  /// "a voice turn is pending" latch belongs to whichever ask settles next, and
  /// that is not necessarily the transcript's own: chat.js drops incoming
  /// messages while busy, so a transcript spoken during a typed composition is
  /// discarded and the latch stays armed until the TYPED question's answer
  /// arrives -- which then gets read aloud. Carrying the flag with the utterance
  /// (matched at the ask, see pendingVoiceUtterance) is what makes speaking
  /// impossible on any turn but the spoken one.
  private func speakIfVoiceTurn(_ data: [String: Any], voiceTurn: Bool) {
    guard voiceTurn else { return }
    guard let text = data["text"] as? String, data["state"] as? String == "ok" else { return }
    delegate?.speakAnswer(text)
  }

  /// The proposed claim that would have answered this question, if any.
  ///
  /// Only ever called when the answer came back with no sources, so it costs a
  /// loopback GET on exactly the turns that had nothing to show anyway. Failure
  /// is silent by design: a suggestion that does not arrive leaves an ordinary
  /// abstention, which is what the turn already was.
  private func suggestion(for question: String, done: @escaping ([String: Any]?) -> Void) {
    guard let tok = bearerToken(), !question.isEmpty,
          // A query string, so URLComponents rather than the request() helper:
          // that appends a PATH component and would escape the "?" into the path.
          var comps = URLComponents(url: hermesBase.appendingPathComponent("admin/memory/suggest"),
                                    resolvingAgainstBaseURL: false) else { done(nil); return }
    comps.queryItems = [
      URLQueryItem(name: "q", value: question),
      URLQueryItem(name: "limit", value: "1"),
    ]
    guard let url = comps.url else { done(nil); return }
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 4
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: req) { data, _, _ in
      var first: [String: Any]?
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let claims = obj["claims"] as? [[String: Any]] {
        first = claims.first
      }
      DispatchQueue.main.async { done(first) }
    }.resume()
  }

  /// hermes' own row count, or 0 when it cannot be reached. Used as the honest
  /// answer to "is any of my data actually in here yet" -- a number that only
  /// moves when a connector really read something and really wrote it.
  /// Row count AND how far the memory is through reading them.
  ///
  /// The count alone was misleading in the way that mattered: rows arrive fast,
  /// and the app still cannot answer until those rows are DISTILLED into claims.
  /// Reporting only "found many things" while every question abstained is what
  /// produced "it has full access and knows nothing". /stats carries both numbers
  /// now; this passes the second one through untouched.
  private func rows(_ done: @escaping (Int, [String: Any]?) -> Void) {
    guard let tok = bearerToken() else { done(0, nil); return }
    let req = request("GET", hermesBase, "stats", bearer: tok, timeout: 4)
    URLSession.shared.dataTask(with: req) { data, _, _ in
      var n = 0
      var memory: [String: Any]?
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        n = obj["rows"] as? Int ?? 0
        memory = obj["memory"] as? [String: Any]
      }
      DispatchQueue.main.async { done(n, memory) }
    }.resume()
  }

  /// Write the connectors config if it is missing, retire the launchd agent
  /// and start the daemon as a child of this app.
  ///
  /// THE ONE PLACE THAT DOES IT, because two callers need all three steps and
  /// one of them used to do only the last. The config is what makes the daemon
  /// boot AT ALL — without it the agent parks at exit 1, and Connectors.start()
  /// returns silently — so writing it is the whole action, and an importer
  /// that calls start() alone on a machine where screen 2 was skipped
  /// schedules nothing at all.
  ///
  /// MAIN QUEUE ONLY. Connectors.start() takes no lock, reads and writes
  /// isRunning, lastStart and process, and re-dispatches its own throttle
  /// retry and termination handling onto .main — it is main-thread-assumed,
  /// and every other call site is on main. The LinkedIn import runs its checks
  /// on a background queue, so it hops before it calls this.
  @discardableResult
  private func startReadingSources() -> (configWritten: Bool, outcome: Connectors.StartOutcome) {
    dispatchPrecondition(condition: .onQueue(.main))
    // There is no list of sources to choose: the daemon runs every connector
    // it has credentials for and each one's needs() gates it, so the local
    // Apple stores turn on together the moment Full Disk Access lands.
    let ok = writeConnectorsConfigIfMissing()
    // THE ONE CARD A DAY SCREEN 1 PROMISED, AND THE PRODUCER THAT MAKES IT.
    //
    // hermes gates the whole reconnect card on relationshipMemory.capPerDay and
    // fails closed when it is absent -- no config, no cards -- because a
    // threshold is the owner's to set and never one the server invents. The
    // file written just above is `{}`, so without this the card never arrives
    // on a fresh install no matter how much the reader ingests.
    //
    // This is not the app inventing that threshold either. Screen 1 says "one
    // person a day" in its title and "one card a day" in the paragraph under
    // it, directly above the button the owner pressed to get here: the press is
    // the owner accepting one a day, and this is onboarding writing down what
    // they were shown. hermes writes it only when the key is absent, so a
    // second run of the flow never overrides a number they later changed.
    //
    // The producer travels with it because it has the same shape of problem.
    // hermes reads an absent relationshipMemory.producer as the legacy matcher
    // path, which is the safe reading for an owner who chose to stay there and
    // the wrong one for a machine with no owner history at all: the card this
    // app ships is the eligibility producer's, and every judgment behind it was
    // made against that producer. Same rule, same call, written only if absent.
    //
    // Recorded before the reader starts and never gating it: these decide
    // whether a card appears tomorrow, and a hermes that is not up yet is no
    // reason to leave every source unread today. Asynchronous, retried, and
    // remembered across launches -- see recordCardDefaults.
    recordCardDefaults()
    // Started as a CHILD of this app, not bootstrapped into launchd, so the
    // reader inherits this app's permissions instead of needing its own.
    Provision.retireConnectorsAgent()
    let outcome = Connectors.shared.start()
    // AND IF IT WAS ALREADY UP, TELL IT SOMETHING CHANGED.
    //
    // start() is idempotent and therefore silent when the daemon is running,
    // which is the case on every call after the first — and those later calls
    // are the interesting ones: this method is called when screen 2 is left,
    // after the Google sign-in, after the LinkedIn import and on entering
    // screen 6. On the second clean-machine run the daemon had already answered
    // "not ready" for mail and linkedin before the owner did either, and
    // nothing here told it otherwise; ten minutes later it still had not asked
    // again. The nudge is what makes the reader look within seconds of the
    // owner finishing. See Connectors.nudge().
    Connectors.shared.nudge()
    Distiller.shared.start()
    return (ok, outcome)
  }

  /// Roughly two minutes of attempts, front-loaded. hermes' own warm-up window
  /// is the case this covers, and it is seconds rather than minutes; the long
  /// tail is for a hermes that is being reinstalled underneath the app.
  private static let cardDefaultsRetryDelays: [Double] = [2, 4, 8, 12, 16, 16, 16, 16, 16]

  /// WRITE THE INTENT DOWN, THEN TRY TO DELIVER IT.
  ///
  /// The owner's press is the decision; the POST is only how it travels. This
  /// used to be one fire-and-forget request whose failure was an NSLog, so a
  /// first launch where hermes was still warming -- the ordinary case, since
  /// the same launch starts it -- left relationshipMemory.capPerDay unwritten
  /// and hermes answering no-cap-configured for ever, with the reconnect card
  /// the whole product is about never appearing. The three startedSources call
  /// sites made that a coin flip rather than a certainty.
  ///
  /// The flag is set FIRST and cleared only by a reply that says the settings
  /// were taken, so a crash, a quit mid-retry or a hermes that is down for the
  /// rest of the session all end the same way: the next launch tries again.
  private func recordCardDefaults() {
    Bridge.cardDefaultsPending = true
    postCardDefaults(attempt: 0)
  }

  /// The next launch's half of recordCardDefaults. Called once from
  /// applicationDidFinishLaunching; a no-op on every machine whose settings
  /// have already landed, which after the first success is all of them.
  func resumeCardDefaultsIfPending() {
    if Bridge.cardDefaultsPending { postCardDefaults(attempt: 0) }
    resumeCardModeIfPending()
  }

  /// ONE CHAIN, NOT FOUR. recordCardDefaults is reachable from all three
  /// startedSources call sites and resumeCardDefaultsIfPending fires
  /// independently at launch, so a first launch with hermes down ran four
  /// independent chains of up to ten POSTs each. Nothing breaks -- the route is
  /// write-if-absent and always answers ok -- but it is forty requests where one
  /// was meant, against a hermes that is already struggling, which is the only
  /// condition under which the chains exist at all.
  private var cardDefaultsInFlight = false
  private var cardDefaultsInFlightSince = Date.distantPast
  private var cardModeInFlightSince = Date.distantPast

  /// HOW LONG AN IN-FLIGHT FLAG MAY STAND WITHOUT A COMPLETION.
  ///
  /// The flags are cleared on success and on giving up, which covers every
  /// completion — and a completion that never arrives is not one of them. A
  /// request that neither succeeds nor errors therefore pinned the flag for the
  /// life of the process and made every later resume a silent no-op. The chains
  /// exist only when hermes is already struggling, which is the condition most
  /// likely to produce exactly that. Longer than the whole retry ladder (about
  /// two minutes), so this can never cut a live chain short.
  static let inFlightStaleAfter: TimeInterval = 300

  private func postCardDefaults(attempt: Int) {
    dispatchPrecondition(condition: .onQueue(.main))
    if attempt == 0 {
      if cardDefaultsInFlight,
         Date().timeIntervalSince(cardDefaultsInFlightSince) < Bridge.inFlightStaleAfter { return }
      cardDefaultsInFlight = true
      cardDefaultsInFlightSince = Date()
    }
    relHermes("POST", "admin/config/card",
              json: ["capPerDay": 1, "producer": "eligibility"]) { [weak self] out in
      let state = out["state"] as? String ?? "unknown"
      if state == "ok" {
        Bridge.cardDefaultsPending = false
        self?.cardDefaultsInFlight = false
        return
      }
      guard let self, attempt < Bridge.cardDefaultsRetryDelays.count else {
        // Giving up for this launch only. The flag stays set, which is what
        // makes the next one pick it up.
        NSLog("Intaglio Labs: daily card settings not recorded (\(state)) — retrying next launch")
        self?.cardDefaultsInFlight = false
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + Bridge.cardDefaultsRetryDelays[attempt]) {
        self.postCardDefaults(attempt: attempt + 1)
      }
    }
  }

  private var cardModeInFlight = false

  /// The mode's half of the same story, on the same retry ladder. A reply
  /// without `persisted: true` is not a delivery: the route answers 200 either
  /// way, and 200 is exactly what it says when the config write failed.
  func resumeCardModeIfPending() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let mode = Bridge.cardModePending else { return }
    // A value this build does not recognise, or one that has outlived its
    // ceiling, is dropped rather than re-sent for ever. See cardModeMaxLaunches.
    guard Bridge.relationshipModes.contains(mode),
          Bridge.cardModeLaunches < Bridge.cardModeMaxLaunches
    else {
      NSLog("Intaglio Labs: giving up on an unrecorded card mode after \(Bridge.cardModeLaunches) launches")
      Bridge.cardModePending = nil
      Bridge.cardModeLaunches = 0
      return
    }
    Bridge.cardModeLaunches += 1
    postCardMode(attempt: 0)
  }

  private func postCardMode(attempt: Int) {
    guard let mode = Bridge.cardModePending else { cardModeInFlight = false; return }
    if attempt == 0 {
      if cardModeInFlight,
         Date().timeIntervalSince(cardModeInFlightSince) < Bridge.inFlightStaleAfter { return }
      cardModeInFlight = true
      cardModeInFlightSince = Date()
    }
    relHermes("POST", "admin/relationship/mode", json: ["mode": mode]) { [weak self] out in
      if out["persisted"] as? Bool == true {
        Bridge.cardModePending = nil
        Bridge.cardModeLaunches = 0
        self?.cardModeInFlight = false
        return
      }
      guard let self, attempt < Bridge.cardDefaultsRetryDelays.count else {
        NSLog("Intaglio Labs: card mode not recorded — retrying next launch")
        self?.cardModeInFlight = false
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + Bridge.cardDefaultsRetryDelays[attempt]) {
        self.postCardMode(attempt: attempt + 1)
      }
    }
  }

  /// The connectors daemon refuses to start without ~/.hazlie/connectors/config.json
  /// and says so; on a fresh install nothing writes it, so the agent parks at
  /// exit 1 forever and no data ever arrives. This writes the minimum valid one.
  ///
  /// Deliberately almost empty. There is no "enabled sources" list to fill in --
  /// every install runs every connector it has credentials for, and each source's
  /// needs() decides whether it can run this pass. So the file's job here is to
  /// exist and to parse; every key in it is an override nobody has asked for yet.
  ///
  /// Held to the same file standard as a secret (0600 inside the 0700 tree),
  /// because daemon.mjs checks: it is the file whose silent replacement would
  /// redirect what gets polled.
  @discardableResult
  private func writeConnectorsConfigIfMissing() -> Bool {
    let fm = FileManager.default
    let dir = fm.homeDirectoryForCurrentUser.appendingPathComponent(".hazlie/connectors")
    let file = dir.appendingPathComponent("config.json")
    if fm.fileExists(atPath: file.path) { return true }
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
      try "{}\n".write(to: file, atomically: true, encoding: .utf8)
      try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      return true
    } catch {
      return false
    }
  }

  // Messages that arrived before chat.js finished loading queue one by one
  // (main.swift). chatReady hands the page the first; each settled ask pulls
  // the next through __hzIncoming, so every queued message becomes its own
  // ask. The page is idle by then: reply()'s evaluateJavaScript resolved the
  // ask's promise, whose continuation drops chat.js's busy flag before this
  // later evaluateJavaScript runs.
  private func deliverNextQueued(to webView: WKWebView) {
    DispatchQueue.main.async { [weak self] in
      guard let self,
            let next = self.delegate?.takePendingUtterance(), !next.isEmpty,
            let json = try? JSONSerialization.data(withJSONObject: [next]),
            let arr = String(data: json, encoding: .utf8)
      else { return }
      webView.evaluateJavaScript(
        "window.__hzIncoming && window.__hzIncoming(\(arr)[0])", completionHandler: nil)
    }
  }

  // MARK: auth

  // Re-read per request, matching hermes' own semantics: rotation needs no
  // restart. 0600 on disk; a webview could never read this file — only this
  // native process can, which is the whole reason the bearer channel exists.
  private func bearerToken() -> String? {
    let url = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/secrets/hermes-token.txt")
    guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
    let tok = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let hex = Set("0123456789abcdef")
    guard tok.count == 64, tok.allSatisfy({ hex.contains($0) }) else { return nil }
    return tok
  }

  private func request(
    _ method: String, _ base: URL, _ path: String,
    bearer: String?, json: [String: Any]? = nil, timeout: TimeInterval? = nil
  ) -> URLRequest {
    // The path may carry a query ("people/review?days=365"). It cannot ride
    // appendingPathComponent whole — that percent-encodes the '?', hermes
    // then sees one literal path component and 404s — so split it here and
    // let URLComponents keep '?' a delimiter, the way bridgeCall builds its
    // URLs.
    let url: URL
    if let q = path.firstIndex(of: "?") {
      var comps = URLComponents(
        url: base.appendingPathComponent(String(path[..<q])), resolvingAgainstBaseURL: false)!
      comps.query = String(path[path.index(after: q)...])
      url = comps.url!
    } else {
      url = base.appendingPathComponent(path)
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    if let t = timeout { req.timeoutInterval = t }
    if let b = bearer { req.setValue("Bearer \(b)", forHTTPHeaderField: "Authorization") }
    if let j = json {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: j)
    }
    // No Origin header is ever set — URLSession doesn't add one, and that
    // absence IS the widget's channel: hermes and connect route bearer auth
    // only for Origin-less requests.
    return req
  }

  // MARK: status

  /// Correct local Apple-source rows in the process that actually owns their
  /// permissions. The connect server is a launchd agent, while the connector
  /// daemon is this app's child and inherits this app's TCC identity. Trusting
  /// the server's protected-file probes therefore paints false red tiles even
  /// while ingestion can read the stores normally. Calendar and Contacts are
  /// framework-backed, so their native authorization belongs here too.
  private func reconcileLocalSourceStatus(_ obj: [String: Any]) -> [String: Any] {
    guard let sources = obj["sources"] as? [[String: Any]] else { return obj }
    let readable = Permissions.accessibleLocalSources()
    guard !readable.isEmpty else { return obj }
    let details = [
      "imessage": "reading your message history",
      "calendar": "reading the local calendar store",
      "contacts": "names behind the numbers",
      "photos": "reading time, place and who is in them",
      "notes": "reading what you wrote",
    ]
    var out = obj
    out["sources"] = sources.map { source in
      guard let id = source["id"] as? String,
            source["action"] as? String == "fda",
            readable.contains(id)
      else { return source }
      var fixed = source
      fixed["connected"] = true
      fixed["broken"] = false
      fixed["detail"] = details[id] ?? "available to Intaglio Labs"
      fixed["action"] = NSNull()
      fixed["fix"] = NSNull()
      fixed["caveat"] = NSNull()
      return fixed
    }
    return out
  }

  private func fetchStatus(_ done: @escaping ([String: Any]) -> Void) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    let req = request("GET", connectBase, "api/status", bearer: tok, timeout: 5)
    session.dataTask(with: req) { data, resp, err in
      guard err == nil, let http = resp as? HTTPURLResponse else {
        done(["state": "down"]); return
      }
      switch http.statusCode {
      case 200:
        guard let d = data,
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              obj["sources"] is [[String: Any]]
        else { done(["state": "error", "error": "unparseable status"]); return }
        var out = self.reconcileLocalSourceStatus(obj)
        out["state"] = "ok"
        done(out)
      case 401: done(["state": "auth"])
      case 404: done(["state": "noroute"]) // connect predates /api/status
      default: done(["state": "error", "error": "http \(http.statusCode)"])
      }
    }.resume()
  }

  // MARK: social bridges

  // The bridge-login lane (ops/WIDGET-BRIDGE-LOGIN-SPEC.md): three calls that
  // mirror fetchStatus — same bearer, same Origin-less channel, same loopback
  // base — driving the local bridge bots for Messenger/Instagram. The cookie
  // paste rides this once and is masked server-side out of every transcript;
  // nothing here stores or logs it. begin/cookies wait on a live bot, so they
  // get 15s where status gets 5.
  /// Discord's login, end to end: open the window on the press, ask the bot
  /// for a QR, show it, and poll the bridge until the phone approves it.
  ///
  /// THE WINDOW OPENS FIRST. `login` is a round trip to a bot in a container
  /// (3.8s measured here), and doing that before showing anything is what made
  /// the tile look dead on the first press — the owner pressed twice and read
  /// the second press as the one that worked. Instagram's window is up
  /// immediately because its policy is static; this one now opens on the same
  /// press and fills in when the code lands.
  ///
  /// The QR is the bridge's own Matrix media, inlined as a data: URI by the
  /// connect server (lib/bridge.mjs inlineMedia, images only and capped) —
  /// this process fetches nothing to show it.
  ///
  /// WHAT COMES BACK to the page is deliberately not the transcript. A
  /// finished attempt's QR is redacted by the bridge, so replaying the
  /// conversation into the card is how the card ended up showing the words
  /// around a code that was no longer there; the card gets a fresh status
  /// instead, or `cancelled`, which is the state its begin button already
  /// knows how to answer.
  private func presentQrLogin(_ webView: WKWebView, id: Int, p: String, label: String) {
    // A bot reply with no image — "You're already logged in", or a bridge that
    // is down — is the card's to show, not this window's. Captured here so the
    // close path can hand it back.
    var fallback: [String: Any]?
    // ENDING TAKES TWO POLLS IN A ROW. The bot posts "Error logging in:
    // websocket: close sent" for a socket that lapsed, and on this machine
    // that line was followed by "Successfully logged in" from the scan the
    // owner had just done — so a window that closed on the first sighting
    // would have closed a login that was about to succeed.
    var endingStreak = 0
    // Main thread: this is reached from a URLSession completion, and it puts a
    // window on screen.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      BridgeLogin.presentQR(
        label: label,
        // Owner's wording (2026-08-26). Not "the Discord app": a phone camera
        // recognises the code and offers the app itself, and naming a second
        // piece of software to go and open first is a step that is not there.
        instruction: "Scan with Discord on your phone, then approve",
        fetch: { [weak self] deliver in
          guard let self else { deliver(nil); return }
          self.beginBridgeLogin(p) { begun in
            guard begun["state"] as? String == "ok" else {
              fallback = begun
              deliver(nil)
              return
            }
            // The LAST bot image: a retried login posts a second code, and the
            // stale one is still above it in the transcript.
            let transcript = begun["transcript"] as? [[String: Any]] ?? []
            let qr = transcript.reversed().first { m in
              (m["from"] as? String) == "bot"
                && (m["image"] as? String)?.hasPrefix("data:image/") == true
            }?["image"] as? String
            if qr == nil {
              fallback = ["state": "manual", "transcript": begun["transcript"] ?? []]
            }
            deliver(qr)
          }
        },
        check: { [weak self] report in
          guard let self else { return }
          self.bridgeCall("GET", "api/bridge", query: ["p": p]) { st in
            if st["connected"] as? Bool == true { report(.connected); return }
            // The bridge says it is over in words, and they are the bot's own.
            // Matching the shape rather than the sentence, because that string
            // is the container's to change.
            let lines = (st["transcript"] as? [[String: Any]] ?? [])
              .compactMap { ($0["from"] as? String) == "bot" ? $0["body"] as? String : nil }
            let last = lines.last?.lowercased() ?? ""
            let over = last.contains("error logging in") || last.contains("websocket")
              || last.contains("timed out") || last.contains("cancelled")
            endingStreak = over ? endingStreak + 1 : 0
            report(endingStreak >= 2 ? .ended : .waiting)
          }
        }
      ) { [weak self] result in
        guard let self else { return }
        guard result != nil else {
          self.reply(webView, id, fallback ?? ["state": "cancelled"])
          return
        }
        // Linked. Re-read rather than reporting the poll's own copy, so the card
        // paints from the same source every other path uses.
        self.bridgeCall("GET", "api/bridge", query: ["p": p]) { done in
          self.reply(webView, id, done)
        }
      }
    }
  }

  private func xPasscodeQuestion(_ state: [String: Any]) -> String? {
    guard let question = state["pendingQuestion"] as? String,
          !question.isEmpty,
          question.range(of: "\\b(pin|passcode)\\b", options: [.regularExpression, .caseInsensitive]) != nil
    else { return nil }
    return question
  }

  /// Only bot lines count as progress. The relay echoes the owner's masked
  /// answer immediately, while the bridge may take several more seconds to
  /// accept or reject it; treating that echo as a reply would offer a retry
  /// before X had answered.
  private func bridgeBotSignature(_ state: [String: Any]) -> String {
    let transcript = state["transcript"] as? [[String: Any]] ?? []
    return transcript.compactMap { line -> String? in
      guard line["from"] as? String == "bot" else { return nil }
      return "\(line["ts"] ?? "")|\(line["body"] as? String ?? "")"
    }.joined(separator: "\u{0000}")
  }

  /// Wait for X's bridge—not merely the HTTP request—to advance. Used once
  /// after cookies (waiting for the encrypted-DM question) and after each
  /// passcode answer (waiting for connected or a validation response).
  private func awaitXBridgeStep(
    _ state: [String: Any], afterBotSignature: String? = nil, attempt: Int = 0,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    if state["connected"] as? Bool == true { done(state); return }
    let botChanged = afterBotSignature == nil || bridgeBotSignature(state) != afterBotSignature
    if botChanged && xPasscodeQuestion(state) != nil { done(state); return }
    if state["state"] as? String != "ok" || attempt >= 14 { done(state); return }
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.25) { [weak self] in
      guard let self else { return }
      self.bridgeCall("GET", "api/bridge", query: ["p": "twitter"]) { next in
        self.awaitXBridgeStep(
          next, afterBotSignature: afterBotSignature, attempt: attempt + 1, done
        )
      }
    }
  }

  private func xPasscodeSubmit(initial state: [String: Any]) -> BridgeLogin.PasscodeSubmit {
    var current = state
    return { [weak self] value, report in
      guard let self else { report(.retry("the local X connector stopped — try again")); return }
      let before = self.bridgeBotSignature(current)
      self.bridgeCall(
        "POST", "api/bridge/cookies", json: ["p": "twitter", "cookies": value], timeout: 15
      ) { first in
        self.awaitXBridgeStep(first, afterBotSignature: before) { final in
          current = final
          if final["connected"] as? Bool == true {
            report(.connected)
          } else if self.xPasscodeQuestion(final) != nil {
            report(.retry("that passcode didn't work — try again"))
          } else {
            let detail = final["error"] as? String
            report(.retry(detail?.isEmpty == false
              ? detail!
              : "X is still finishing — try again in a moment"))
          }
        }
      }
    }
  }

  // MARK: the LinkedIn export

  /// The header columns that identify LinkedIn's files, and the canonical
  /// names the connector looks for.
  ///
  /// CLASSIFIED BY ANCHOR, NOT BY FILENAME. The owner may have renamed the
  /// file, and a downloaded copy is frequently `Connections (1).csv`. The
  /// anchor is what the parser actually keys on
  /// (connectors/lib/linkedinRows.mjs), so it is also what decides which file
  /// this is — and checking it is checking the parse.
  ///
  /// AND BY A SECOND COLUMN, because one column is not a file identity. The
  /// export zip holds THREE files with an exact `First Name` column:
  /// Connections.csv, Profile.csv and Contacts.csv. On the anchor alone,
  /// picking Profile.csv passes the check and is copied OVER Connections.csv —
  /// and then ingests as connections with no `URL` and no `Connected On`, so
  /// every row lands on the export's fallback timestamp under a hashed slug,
  /// with the screen reporting "imported". A good export destroyed by a file
  /// whose name sounds right.
  ///
  /// `require` names the two columns linkedinRows.mjs actually reads — the
  /// dormancy clock and the profile slug — and one of them must be there.
  /// Contacts.csv's `Profile URL` is a DIFFERENT field, which is why the
  /// comparison below is exact rather than a substring.
  private static let linkedInKinds: [(anchor: String, require: [String], name: String)] = [
    ("First Name", ["Connected On", "URL"], "Connections.csv"),
    ("CONVERSATION ID", [], "messages.csv"),
  ]

  /// Whitespace, newlines and a byte-order mark.
  ///
  /// csv.mjs compares `f.trim() === anchor`, and JS `trim()` strips U+FEFF.
  /// Swift's `.whitespacesAndNewlines` does not, so a BOM'd export would read
  /// its first column as "\u{FEFF}First Name" here and "First Name" there —
  /// the two sides disagreeing about the same file, which is the whole thing
  /// this check exists to prevent.
  private static let csvFieldTrim = CharacterSet.whitespacesAndNewlines
    .union(CharacterSet(charactersIn: "\u{FEFF}"))

  /// Which LinkedIn file this is, decided by THE PARSER'S OWN RULE.
  ///
  /// connectors/lib/csv.mjs finds the header as the first row holding a FIELD
  /// whose trim() equals the anchor. `head.contains(anchor)` is not that rule:
  /// it also accepts a column called "First Name (Legal)" — which passes here
  /// and then throws inside csvObjects — and it accepts the anchor turning up
  /// in LinkedIn's Notes: preamble or in somebody's job title. Same walk, same
  /// comparison, same answer.
  ///
  /// Rows are scanned rather than assuming row zero, because the preamble is
  /// real and csvObjects handles it.
  private static func linkedInKind(of head: String) -> (anchor: String, name: String)? {
    for row in csvRows(head) {
      let fields = csvFields(row)
      for kind in linkedInKinds where fields.contains(kind.anchor) {
        if kind.require.isEmpty || kind.require.contains(where: { fields.contains($0) }) {
          return (kind.anchor, kind.name)
        }
      }
    }
    return nil
  }

  /// One parsed row's fields, trimmed the way csv.mjs trims them. Shared so
  /// that "which file is this" and "how many records does it hold" cannot
  /// drift into two different rules about the same header.
  private static func csvFields(_ row: [String]) -> Set<String> {
    Set(row.map { $0.trimmingCharacters(in: csvFieldTrim) })
  }

  /// RFC-4180 rows: quoted fields, doubled-quote escapes, and commas and
  /// newlines inside quotes. The same character walk as connectors/lib/csv.mjs
  /// because it has to reach the same header row on the same file.
  ///
  /// ONE WALK, TWO CONSUMERS, AND ONLY ONE OF THEM KEEPS ANYTHING. The rows
  /// are handed over as they are parsed and dropped again unless the caller
  /// holds on to them: countRows() reads a whole 8-10 MB export through this
  /// and keeps one row at a time, where collecting first meant ~400k live
  /// Strings for a 30k-connection file while the import button spun. csvRows()
  /// below is the collecting caller, and it is only ever handed a 4 KB head.
  ///
  /// A bounded head's final row may be a fragment. That is fine: a fragment
  /// either holds the columns or it does not, and a header that does not fit
  /// in 4 KB is not a LinkedIn export.
  private static func csvScan(_ text: String, _ onRow: ([String]) -> Void) {
    var row: [String] = []
    var field = ""
    var inQuotes = false
    var iterator = text.makeIterator()
    var pending: Character?
    while let c = pending ?? iterator.next() {
      pending = nil
      if inQuotes {
        if c == "\"" {
          guard let next = iterator.next() else { inQuotes = false; break }
          if next == "\"" { field.append("\""); continue }
          inQuotes = false
          pending = next
          continue
        }
        field.append(c)
        continue
      }
      if c == "\"" { inQuotes = true; continue }
      if c == "," { row.append(field); field = ""; continue }
      if c == "\n" || c == "\r" {
        // CRLF is one ending, not two.
        if c == "\r", let next = iterator.next(), next != "\n" { pending = next }
        row.append(field)
        field = ""
        onRow(row)
        row = []
        continue
      }
      field.append(c)
    }
    if !field.isEmpty || !row.isEmpty {
      row.append(field)
      onRow(row)
    }
  }

  /// Every row at once, for the callers that need to look back over them. Only
  /// ever handed a bounded head — see csvScan.
  private static func csvRows(_ text: String) -> [[String]] {
    var rows: [[String]] = []
    csvScan(text) { rows.append($0) }
    return rows
  }

  /// Where the installed export lives — the directory
  /// connectors/sources/linkedin.mjs polls.
  ///
  /// A TYPE PROPERTY, because the Downloads watcher asks whether an export is
  /// already here before there is any reason to hold a Bridge. See ExportWatch.
  static var linkedInDirectory: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/imports/linkedin", isDirectory: true)
  }

  /// Whether an export is installed AND still parses — the Downloads watcher's
  /// only question, and the condition that stops it watching.
  ///
  /// The same rule the import applies, not `fileExists`: a truncated or
  /// hand-dropped file that the connector cannot read is not an export the
  /// owner has, and a watcher that fell silent on one would be waiting for a
  /// file that had already been "found".
  static var linkedInExportInstalled: Bool {
    let destination = Bridge.linkedInDirectory.appendingPathComponent("Connections.csv")
    guard FileManager.default.fileExists(atPath: destination.path),
          let head = readHead(of: destination, bytes: 4096),
          let kind = linkedInKind(of: head)
    else { return false }
    return kind.name == "Connections.csv"
  }

  /// THE FILE LINKEDIN ACTUALLY SENDS.
  ///
  /// "Get a copy of your data" arrives as `Complete_LinkedInDataExport_*.zip`
  /// or `Basic_LinkedInDataExport_*.zip` — never as a bare CSV — so the picker
  /// used to greet the owner's own download with "that's the zip, unzip it
  /// yourself". The comment that justified it said extraction would mean a
  /// subprocess and every check in this flow runs in this process; that was
  /// true and it was the wrong trade. One `/usr/bin/unzip` beats asking the
  /// owner to do the work by hand on the screen that is about handing a file
  /// over. (Foundation has no archive API at all, so there is no third option.)
  ///
  /// ONE ENTRY, BY NAME, AND NOTHING ELSE. The pattern is the literal
  /// `Connections.csv` with no wildcard in it, so unzip can match at most the
  /// one root entry: a `dir/Connections.csv` does NOT match, and neither does
  /// anything else in the archive. The export holds Profile.csv and
  /// Contacts.csv, both of which carry an exact `First Name` column and both of
  /// which would destroy a good import if they landed at the destination —
  /// linkedInKind's second column is the check that catches that, and refusing
  /// by name here means it never has to.
  ///
  /// The zip's own modification date is stamped onto the extracted copy. Every
  /// caller downstream reads that date — PASS ONE refuses an older export than
  /// the installed one, and the swap records it as the vintage — and a freshly
  /// extracted file is dated `now`, which would make last year's archive look
  /// like today's export.
  ///
  /// Returns nil for an archive that could not be read at all, and
  /// `.notFound` for one that opened and has no Connections.csv in it: those
  /// are different sentences on the screen, and only the second has a remedy.
  enum ZipExtraction {
    case extracted(URL)
    /// The archive opened; there is no root `Connections.csv` in it.
    case notFound
    /// Could not be read as an archive at all.
    case unreadable
  }

  /// A cap on what comes out of the archive. A 30k-connection Connections.csv
  /// is 8-10 MB; this is three orders of magnitude of headroom and still stops
  /// a hostile archive filling the owner's disk. Exceeding it kills unzip and
  /// reports the archive as unreadable, which is what it is.
  private static let zipExtractionCap = 512 * 1024 * 1024

  static func extractConnections(fromZipAt zip: URL) -> ZipExtraction {
    let fm = FileManager.default
    let out = fm.temporaryDirectory
      .appendingPathComponent("hazlie-linkedin-\(UUID().uuidString)")
      .appendingPathComponent("Connections.csv")
    do {
      try fm.createDirectory(at: out.deletingLastPathComponent(),
                             withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
    } catch { return .unreadable }
    let discard = { try? fm.removeItem(at: out.deletingLastPathComponent()) }

    // NO SHELL, and an absolute path. `arguments` goes to execve directly, so
    // nothing in the file name is interpreted — and a file URL's `path` always
    // begins with "/", so unzip can never read the archive's own name as one of
    // its flags.
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    task.arguments = ["-p", zip.path, "Connections.csv"]
    let pipe = Pipe()
    task.standardOutput = pipe
    // unzip's own chatter is not for the owner; the reply says what happened.
    task.standardError = FileHandle.nullDevice
    guard (try? task.run()) != nil else { discard(); return .unreadable }

    guard fm.createFile(atPath: out.path, contents: nil,
                        attributes: [.posixPermissions: 0o600]) else {
      task.terminate()
      discard()
      return .unreadable
    }
    guard let sink = try? FileHandle(forWritingTo: out) else {
      task.terminate(); discard(); return .unreadable
    }
    var written = 0
    var overflowed = false
    while true {
      let chunk = pipe.fileHandleForReading.availableData
      if chunk.isEmpty { break }
      written += chunk.count
      if written > zipExtractionCap {
        overflowed = true
        // Killed rather than left to fill the disk behind us — and the pipe is
        // drained afterwards, because a terminate() with a full pipe can leave
        // the child blocked in write().
        task.terminate()
        break
      }
      sink.write(chunk)
    }
    if overflowed { while !pipe.fileHandleForReading.availableData.isEmpty {} }
    try? sink.close()
    task.waitUntilExit()

    if overflowed { discard(); return .unreadable }
    // unzip answers 11 for "no matching files", which is the archive opening
    // fine and holding no Connections.csv — the one failure with a remedy in it.
    if task.terminationStatus == 11 { discard(); return .notFound }
    guard task.terminationStatus == 0, written > 0 else {
      discard()
      // A zero-byte success is an empty entry, which is not an export either.
      return task.terminationStatus == 0 ? .notFound : .unreadable
    }

    // THE ARCHIVE'S OWN DATE, or the vintage is "now" and PASS ONE below cannot
    // tell last year's download from today's.
    if let vintage = try? zip.resourceValues(forKeys: [.contentModificationDateKey])
      .contentModificationDate {
      var dated = out
      var values = URLResourceValues()
      values.contentModificationDate = vintage
      try? dated.setResourceValues(values)
    }
    return .extracted(out)
  }

  private func importLinkedIn(_ done: @escaping ([String: Any]) -> Void) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let panel = NSOpenPanel()
      panel.allowsMultipleSelection = true
      panel.canChooseDirectories = false
      panel.canChooseFiles = true
      // THE ZIP IS THE ORDINARY CASE, so it is named first. LinkedIn mails a
      // link to an archive; a bare Connections.csv only exists once somebody has
      // already unzipped one.
      panel.message = "choose the zip LinkedIn sent you, or Connections.csv from inside it"
      panel.prompt = "import"
      // ~~".zip is offered so the file the owner just downloaded is SELECTABLE
      // rather than greyed out with no explanation. It is refused below with a
      // sentence rather than extracted: unzipping would mean a subprocess, and
      // every check in this flow runs in this process."~~ Still offered, no
      // longer refused: extractConnections takes Connections.csv out of it and
      // the checks below run on that, unchanged. The subprocess is real and is
      // the smaller cost — see extractConnections.
      var types: [UTType] = [.commaSeparatedText]
      if let zip = UTType("public.zip-archive") { types.append(zip) }
      panel.allowedContentTypes = types
      // The onboarding scrim is a full-screen floating window; an ordinary
      // panel opens underneath it. Same reason requestPermission yields.
      self.delegate?.yieldForPrompt(true)
      panel.begin { response in
        self.delegate?.yieldForPrompt(false)
        guard response == .OK, !panel.urls.isEmpty else {
          done(["state": "cancelled"])
          return
        }
        DispatchQueue.global(qos: .userInitiated).async {
          done(self.acceptLinkedInFiles(panel.urls))
        }
      }
    }
  }

  /// The same import, for files nobody picked in a panel: the Downloads watcher
  /// noticing an export land, and a file dropped onto the settings panel. Same
  /// check, same copy, same reply shape — acceptLinkedInFiles is the whole
  /// import and neither caller gets a shortcut through it.
  func importLinkedIn(files urls: [URL], _ done: @escaping ([String: Any]) -> Void) {
    guard !urls.isEmpty else { done(["state": "cancelled"]); return }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { done(["state": "cancelled"]); return }
      let out = self.acceptLinkedInFiles(urls)
      // The two pages that render this file's state repaint themselves; an
      // import the owner did not start must not leave screen 4 still saying
      // "waiting" about a file that has landed.
      if out["state"] as? String == "ok" {
        DispatchQueue.main.async { self.delegate?.linkedInExportChanged() }
      }
      done(out)
    }
  }

  /// Check every picked file, then copy — and answer with the count this app
  /// counted itself.
  ///
  /// TWO PASSES, AND THAT IS THE POINT. The check and the copy used to share
  /// one loop, so a multi-select of Connections.csv + Profile.csv copied the
  /// first, failed on the second, painted an error and never started the
  /// reader: a half-applied import with nothing scheduled to read it, and no
  /// way for the owner to tell which half landed. A pick is ONE action. It
  /// succeeds whole or it changes nothing on disk.
  ///
  /// The copies themselves are staged beside their destinations and swapped in
  /// only once every one of them has landed. The swap is
  /// `FileManager.replaceItemAt`, which is the atomic primitive: the old
  /// `removeItem(destination)` + `moveItem` pair had a window in which the
  /// previous export was already gone and the replacement was still named
  /// `.importing`, and a crash there destroyed an export the owner had. Each
  /// replace also leaves the file it displaced beside it as `.previous`, so a
  /// failure on the SECOND file of a multi-select puts the first one back
  /// rather than leaving Connections.csv new and messages.csv old. The
  /// backups are removed once every file has landed.
  ///
  /// N FILES MEANS N DIFFERENT FILES. Two picks of the same kind -- the export
  /// and the browser's second download of it -- share a destination, and the
  /// whole-or-nothing story does not survive two turns round the swap loop
  /// aimed at the same path: the second consumed the first one's backup and
  /// then failed, leaving nothing to undo with. They are refused in the first
  /// pass, by name, before anything is written.
  ///
  /// A ZIP IS A PICKED FILE TOO, and it is the one LinkedIn actually sends.
  /// PASS ZERO takes Connections.csv out of each archive and hands the extracted
  /// copy to the rest of this function; everything after it is unchanged, which
  /// is the point — the archive buys no shortcut past the header check, the
  /// vintage comparison or the atomic swap. The owner still sees the name they
  /// picked in every refusal, because "Complete_LinkedInDataExport_2026.zip" is
  /// what is in their Downloads folder and "Connections.csv" is not.
  private func acceptLinkedInFiles(_ urls: [URL]) -> [String: Any] {
    let fm = FileManager.default

    // PASS ZERO: unpack the archives. Nothing is written outside the temporary
    // directory, and every extracted copy is removed on the way out of this
    // function however it leaves.
    var extracted: [URL] = []
    defer {
      for temporary in extracted {
        try? fm.removeItem(at: temporary.deletingLastPathComponent())
      }
    }
    // `url` is what gets read and copied; `label` is what the owner picked and
    // is the only one of the two that may appear in a message.
    var picked: [(url: URL, label: String)] = []
    for url in urls {
      guard url.pathExtension.lowercased() == "zip" else {
        picked.append((url, url.lastPathComponent))
        continue
      }
      switch Bridge.extractConnections(fromZipAt: url) {
      case .extracted(let csv):
        extracted.append(csv)
        picked.append((csv, url.lastPathComponent))
      case .notFound:
        // THE ONE ZIP FAILURE WITH A REMEDY IN IT: the archive is fine and the
        // owner asked LinkedIn for the wrong thing, or for everything and got a
        // partial first. Named separately so the screen can say which.
        return [
          "state": "error", "reason": "zip-connections",
          "file": url.lastPathComponent,
        ]
      case .unreadable:
        return ["state": "error", "reason": "zip", "file": url.lastPathComponent]
      }
    }

    // PASS ONE: every file is checked, and nothing is written.
    var accepted: [(url: URL, label: String, kind: (anchor: String, name: String))] = []
    for (url, label) in picked {
      // 4 KB is well past LinkedIn's Notes: preamble and its header, and a
      // bounded read means a file the owner picked by mistake -- a 2 GB
      // video renamed .csv -- costs one page, not a stall.
      guard let head = Bridge.readHead(of: url, bytes: 4096) else {
        return ["state": "error", "reason": "unreadable", "file": label]
      }
      guard let kind = Bridge.linkedInKind(of: head) else {
        // NAME THE COLUMN BACK. "I cannot read this" is an accusation with no
        // remedy in it; "the first one is Prénom" tells the owner exactly what
        // happened and that an English export is the fix.
        return [
          "state": "error", "reason": "columns",
          "file": label,
          "firstColumn": Bridge.firstColumn(of: head),
        ]
      }
      // ONE FILE PER KIND, AND NEITHER OF TWO IS A DEFAULT.
      //
      // `Connections.csv` and `Connections (1).csv` both classify as
      // Connections.csv, so a multi-select of the two staged both copies to
      // the SAME `.importing` path and swapped both into the same
      // destination. The second turn round the swap loop removed the backup
      // the first had just made, its replace then threw on a temporary that
      // had already been consumed, and the undo had nothing left to put back:
      // the export the owner had was gone and linkedin.mjs reported it
      // missing. That is the one outcome this whole function is written to
      // make impossible, and it happened in exactly the case the undo path
      // was added for.
      //
      // The panel cannot say which of the two was meant — the order `urls`
      // arrive in is the panel's, not a preference — so this refuses and
      // names both files rather than silently picking one.
      //
      // TWO ZIPS ARE TWO PICKS OF THE SAME KIND, and they arrive here as two
      // extracted Connections.csv files with the same name — so the names the
      // owner needs to choose between are the ARCHIVES they picked, which is why
      // the refusal reads `label` and not the extracted file's name.
      if let clash = accepted.first(where: { $0.kind.name == kind.name }) {
        return [
          "state": "error", "reason": "duplicate",
          "file": kind.name,
          "files": [clash.label, label],
        ]
      }
      let destination = Bridge.linkedInDirectory.appendingPathComponent(kind.name)
      // DO NOT REPLACE A NEWER FILE WITH AN OLDER ONE. Onboarding can be
      // replayed from the gear on a machine that already has an export, and
      // the owner reaching for "the LinkedIn file" in Downloads may well find
      // last year's. Compared by modification time, and refused out loud.
      // ...unless this app could not establish the installed file's vintage at
      // all. See unstampedImports: "now" is then a fact about the copy, not
      // about the export, and refusing on it is the dead end.
      //
      // An extracted copy carries the ARCHIVE's date, not the moment it was
      // unpacked — see extractConnections — so a zip from last year is refused
      // here exactly like the CSV inside it would have been.
      if !Bridge.unstampedImports.contains(kind.name),
         let existing = Bridge.installedVintage(of: destination),
         let pickedVintage = try? url.resourceValues(forKeys: [.contentModificationDateKey])
          .contentModificationDate,
         existing > pickedVintage {
        return [
          "state": "error", "reason": "newer",
          "file": kind.name,
        ]
      }
      accepted.append((url, label, kind))
    }

    // PASS TWO: stage every copy, then swap them in.
    do {
      try fm.createDirectory(at: Bridge.linkedInDirectory, withIntermediateDirectories: true,
                             attributes: [.posixPermissions: 0o700])
      try fm.setAttributes([.posixPermissions: 0o700],
                           ofItemAtPath: Bridge.linkedInDirectory.path)
    } catch {
      return ["state": "error", "reason": "copy", "file": accepted.first?.kind.name ?? ""]
    }
    var staged: [(temporary: URL, destination: URL, kind: (anchor: String, name: String),
                  vintage: Date?)] = []
    let discardStaged = { for entry in staged { try? fm.removeItem(at: entry.temporary) } }
    for entry in accepted {
      let destination = Bridge.linkedInDirectory.appendingPathComponent(entry.kind.name)
      let temporary = Bridge.linkedInDirectory
        .appendingPathComponent("\(entry.kind.name).importing")
      do {
        if fm.fileExists(atPath: temporary.path) { try fm.removeItem(at: temporary) }
        try fm.copyItem(at: entry.url, to: temporary)
        // The owner's professional graph, in a directory only they can open.
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
      } catch {
        discardStaged()
        try? fm.removeItem(at: temporary)
        return ["state": "error", "reason": "copy", "file": entry.kind.name]
      }
      // Read from the PICKED file rather than the copy: this is the export's
      // own date, and the swap below puts it on the destination's creation
      // date so it survives the modification date being stamped to now.
      let vintage = try? entry.url.resourceValues(forKeys: [.contentModificationDateKey])
        .contentModificationDate
      staged.append((temporary, destination, entry.kind, vintage))
    }

    var copied: [String] = []
    // Names whose vintage could not be recorded; see unstampedImports. Carried
    // back so the flow can say so rather than leaving it to a comment.
    var unknownVintage: [String] = []
    var connections = 0
    // What has already been swapped in, and what it displaced. `backup` is nil
    // where there was nothing to displace -- a first import -- and undoing
    // that one means removing the file this pick put there.
    var swapped: [(destination: URL, backup: URL?)] = []
    let undoSwapped = {
      for entry in swapped.reversed() {
        guard let backup = entry.backup else {
          // Nothing was displaced, so undoing it is removing what we put there.
          try? fm.removeItem(at: entry.destination)
          continue
        }
        do {
          // `.usingNewMetadataOnly` here for the same reason as in the swap:
          // the default keeps the metadata of the item being replaced, which
          // is the file this pick just wrote and whose dates were stamped.
          // The backup has to come back as itself, vintage included.
          _ = try fm.replaceItemAt(entry.destination, withItemAt: backup,
                                   options: [.usingNewMetadataOnly])
        } catch {
          // The atomic path refused. Fall back to a rename -- but never delete
          // the backup, which at this point is the owner's only copy of the
          // export this pick displaced.
          try? fm.removeItem(at: entry.destination)
          try? fm.moveItem(at: backup, to: entry.destination)
        }
      }
      swapped = []
    }
    let dropBackups = {
      for entry in swapped { if let backup = entry.backup { try? fm.removeItem(at: backup) } }
    }
    for entry in staged {
      let backupName = "\(entry.kind.name).previous"
      let backup = Bridge.linkedInDirectory.appendingPathComponent(backupName)
      let hadPrevious = fm.fileExists(atPath: entry.destination.path)
      do {
        if hadPrevious {
          // ATOMIC, and it keeps the file it displaced. A per-file
          // remove-then-move is not a swap: it has a window with neither file
          // at the destination, and nothing to put back when a later file in
          // the same pick fails.
          try? fm.removeItem(at: backup)
          _ = try fm.replaceItemAt(
            entry.destination, withItemAt: entry.temporary,
            backupItemName: backupName,
            // `.usingNewMetadataOnly` OR THE READER NEVER SEES THE FILE.
            // replaceItemAt's default is to carry the DISPLACED item's
            // metadata onto the replacement, and the displaced item here is
            // the previous export — whose modification date is precisely the
            // cursor linkedin.mjs compares against
            // (`newestMtime <= stored` skips the scan). Keeping it would mean
            // the new export lands, the screen reports its count, and the
            // connector logs `unchangedSinceMtime: true` forever.
            options: [.withoutDeletingBackupItem, .usingNewMetadataOnly]
          )
        } else {
          // replaceItemAt needs something to replace; on a first import there
          // is nothing, and a rename onto a free name is already atomic.
          try fm.moveItem(at: entry.temporary, to: entry.destination)
        }
      } catch {
        undoSwapped()
        discardStaged()
        return ["state": "error", "reason": "copy", "file": entry.kind.name]
      }
      swapped.append((entry.destination, hadPrevious ? backup : nil))
      // AND THE FILE HAS TO LOOK NEW, not merely be new.
      //
      // `.usingNewMetadataOnly` above stops the previous export's date being
      // carried over, but the staged copy's own date is the PICKED file's,
      // and re-importing an export the connector has already read leaves that
      // date equal to the stored cursor — the same silent skip by a different
      // route. The modification date is therefore stamped to the moment the
      // file landed, which is what the cursor is really asking about.
      //
      // The creation date keeps the export's own vintage, because the refusal
      // in PASS ONE still has to be able to ask how old the installed export
      // is. See installedVintage.
      //
      // Best effort: a stamp that fails costs one skipped scan (the connector
      // catches up when the next export lands) and never the file.
      //
      // BUT ITS FAILURE MUST NOT MAKE THE FILE LOOK NEW. Both dates on a fresh
      // copy are the moment it landed, so a stamp that throws leaves
      // installedVintage answering "now" for an export from last year — and
      // PASS ONE then refuses the owner's own file as "you already have a
      // newer one", permanently, with no way past it but deleting the file by
      // hand. One skipped scan is a cost; a flow that cannot be completed is
      // not. So the fallback puts the export's OWN date back on the
      // modification date: installedVintage takes the earlier of the two, so
      // whichever half of the stamp did land, the vintage is honest again.
      var stamped = entry.destination
      var dates = URLResourceValues()
      dates.contentModificationDate = Date()
      if let vintage = entry.vintage { dates.creationDate = vintage }
      var stampedVintage = entry.vintage != nil
      do {
        try stamped.setResourceValues(dates)
      } catch {
        stampedVintage = false
        if let vintage = entry.vintage {
          var fallback = entry.destination
          var vintageOnly = URLResourceValues()
          vintageOnly.contentModificationDate = vintage
          // The fallback only counts if it LANDED. Inside `if let vintage` the
          // old code could not reach the no-vintage case at all, and a `try?`
          // that swallowed a second failure looked identical to a success.
          stampedVintage = (try? fallback.setResourceValues(vintageOnly)) != nil
        }
      }
      var unstamped = Set(Bridge.unstampedImports)
      if stampedVintage { unstamped.remove(entry.kind.name) } else { unstamped.insert(entry.kind.name) }
      Bridge.unstampedImports = unstamped.sorted()
      if !stampedVintage { unknownVintage.append(entry.kind.name) }
      copied.append(entry.kind.name)
      if entry.kind.name == "Connections.csv" {
        connections = Bridge.countRows(inCsvAt: entry.destination, anchor: entry.kind.anchor)
      }
    }
    dropBackups()

    // The reader only picks a source up when it runs, and the owner is
    // watching this screen now.
    //
    // AND THE CONFIG IS WRITTEN HERE TOO. Connectors.start() returns silently
    // when ~/.hazlie/connectors/config.json is absent, and screen 2's "skip"
    // never calls startSources — so on the skip path this whole import landed
    // a file, reported "N connections", and scheduled nothing to read it. The
    // same call startSources makes, on the queue it is allowed to be made on.
    DispatchQueue.main.async { [weak self] in _ = self?.startReadingSources() }
    return [
      "state": "ok", "files": copied, "connections": connections,
      "unknownVintage": unknownVintage,
    ]
  }

  /// What is already on disk, for a second run of the flow.
  ///
  /// THE SECOND-RUN CASE (design P12). A machine that imported an export last
  /// month still met screen 4 saying only "choose the file", with `next`
  /// disabled — the flow asking again for something the owner had already
  /// given it, and the only way forward being to hand over the same file
  /// twice. This reports the export the app can see: when it landed, and how
  /// many records it holds.
  ///
  /// COUNTS ONLY. No names, no companies, no row content ever crosses the
  /// bridge from this file; the page renders a number and a date and offers to
  /// replace it.
  private func linkedInState() -> [String: Any] {
    let fm = FileManager.default
    let destination = Bridge.linkedInDirectory.appendingPathComponent("Connections.csv")
    guard fm.fileExists(atPath: destination.path),
          let head = Bridge.readHead(of: destination, bytes: 4096),
          let kind = Bridge.linkedInKind(of: head), kind.name == "Connections.csv"
    else { return ["state": "ok", "present": false] }
    let modified = (try? destination.resourceValues(forKeys: [.contentModificationDateKey])
      .contentModificationDate)?.timeIntervalSince1970
    return [
      "state": "ok",
      "present": true,
      "file": kind.name,
      "connections": Bridge.countRows(inCsvAt: destination, anchor: kind.anchor),
      "modifiedTs": modified.map { $0 * 1000 } ?? NSNull(),
    ]
  }

  /// HOW OLD THE INSTALLED EXPORT IS, which is no longer its modification date.
  ///
  /// The swap stamps the destination's modification date to the moment the
  /// file landed, so the reader's mtime cursor sees a new file. That makes the
  /// modification date answer "when did this arrive" — and the refusal in PASS
  /// ONE has to ask the other question, "how old is the export sitting here",
  /// or replaying onboarding and handing back the same file in Downloads comes
  /// out as "that one is older than the one you have".
  ///
  /// The same swap puts the export's own date on the CREATION date, so that
  /// carries the vintage. A file the owner dropped into the directory by hand
  /// has had neither treatment: its modification date IS its vintage, and its
  /// creation date is when it was copied in, which is at or after it. The
  /// earlier of the two is therefore the vintage in both cases, and nothing
  /// has to be stored anywhere to tell the two kinds of file apart.
  private static func installedVintage(of url: URL) -> Date? {
    let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
    return [values?.contentModificationDate, values?.creationDate].compactMap { $0 }.min()
  }

  private static func readHead(of url: URL, bytes: Int) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    guard let data = try? handle.read(upToCount: bytes) else { return nil }
    // A LinkedIn export is UTF-8; a Latin-1 fallback is what lets a French
    // export reach the "your columns are Prénom" message instead of the
    // "unreadable" one, which would be a worse answer to the same file.
    return String(data: data, encoding: .utf8)
      ?? String(data: data, encoding: .isoLatin1)
  }

  /// The first field of the first non-empty line, for the failure message.
  /// Bounded and stripped: this is file content on its way to a screen.
  private static func firstColumn(of head: String) -> String {
    let line = head.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).first ?? ""
    let field = line.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    let cleaned = String(field)
      .trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
      .filter { !$0.isNewline && !($0.unicodeScalars.first.map(CharacterSet.controlCharacters.contains) ?? false) }
    return String(cleaned.prefix(60))
  }

  /// How many records the file holds, counted rather than guessed.
  ///
  /// QUOTE-AWARE, because a LinkedIn position or company can contain a comma
  /// AND a newline inside a quoted field, and counting "\n" would then report
  /// more connections than the owner has. Rows are counted from the row after
  /// the anchor's header, which is also how csvObjects slices them.
  ///
  /// ONE HEADER RULE, NOT TWO. This used to find the header with
  /// `line.contains(anchor)` -- the substring test linkedInKind was rewritten
  /// to abolish, for the same reasons and on the same file. The consequence was
  /// not hypothetical: LinkedIn's export opens with a "Notes:" preamble whose
  /// paragraph mentions the columns, so the same file could be CLASSIFIED on an
  /// exact field match at the real header and COUNTED from a preamble line that
  /// merely contains "First Name", inflating the "N connections already here"
  /// the screen shows by the preamble's offset. Both now find the header by the
  /// same rule, over whole trimmed fields.
  ///
  /// AND THE HEADER IS FOUND IN THE HEAD, then the body is STREAMED. Sharing
  /// the rule used to mean sharing csvRows over the whole file, which for a
  /// 30k-connection export is ~8-10 MB collected into ~400k live Strings on a
  /// background queue while the import button spins. The header is found the
  /// same way on the same bounded 4 KB head linkedInKind classifies from — a
  /// file whose header does not fit in that head never reaches this function,
  /// because the classifier would already have refused it — and the rest of
  /// the file is walked a row at a time and counted, keeping one row.
  private static func countRows(inCsvAt url: URL, anchor: String) -> Int {
    guard let head = readHead(of: url, bytes: 4096),
          let headerIndex = csvRows(head).firstIndex(where: { csvFields($0).contains(anchor) })
    else { return 0 }
    let data = (try? Data(contentsOf: url)) ?? Data()
    guard let text = String(data: data, encoding: .utf8)
      ?? String(data: data, encoding: .isoLatin1) else { return 0 }
    // Rows are ordered and the head is a prefix, so the header's index in the
    // head is its index in the file.
    var index = -1
    var count = 0
    csvScan(text) { row in
      index += 1
      guard index > headerIndex else { return }
      // Blank rows are not records. The old walk skipped empty LINES for the
      // same reason; a row whose every field is empty is the same thing here.
      if row.contains(where: { !$0.trimmingCharacters(in: csvFieldTrim).isEmpty }) { count += 1 }
    }
    return count
  }

  private func bridgeCall(
    _ method: String, _ path: String, query: [String: String] = [:],
    json: [String: Any]? = nil, timeout: TimeInterval = 5,
    _ done: @escaping ([String: Any]) -> Void
  ) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    var url = connectBase.appendingPathComponent(path)
    if !query.isEmpty {
      var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
      comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
      url = comps.url!
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = timeout
    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    if let j = json {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try? JSONSerialization.data(withJSONObject: j)
    }
    session.dataTask(with: req) { data, resp, err in
      guard err == nil, let http = resp as? HTTPURLResponse else {
        done(["state": "down"]); return
      }
      let body = data.flatMap {
        try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
      }
      switch http.statusCode {
      case 200:
        guard var out = body else { done(["state": "error", "error": "unparseable"]); return }
        out["state"] = "ok"
        done(out)
      case 401: done(["state": "auth"])
      default:
        // Non-200 here is genuinely an error, not the bot disagreeing: a
        // WRONG cookie paste comes back 200 with the bot's complaint in the
        // transcript (the JS renders that). 400 is "you pasted nothing", 502
        // is a Matrix/network fault — both carry {error}. Pass it through.
        var out = body ?? [:]
        // Keep a server-authored, actionable state (notably `nobridge`) so
        // beginBridgeLogin can initialize a first-time local bridge instead
        // of reducing every 503 to the generic error state.
        if out["state"] == nil { out["state"] = "error" }
        if out["error"] == nil { out["error"] = "http \(http.statusCode)" }
        done(out)
      }
    }.resume()
  }

  /// Begin a social login. On a brand-new install the connect service answers
  /// `nobridge` until Matrix has its private local state; initialize it once,
  /// then retry the exact same request. The app has already prefetched images
  /// in the background, so this normally covers only config generation and
  /// startup—not a surprise multi-image download at click time.
  private func beginBridgeLogin(_ platform: String, _ done: @escaping ([String: Any]) -> Void) {
    bridgeCall("POST", "api/bridge/begin", json: ["p": platform], timeout: 22) { [weak self] first in
      guard let self else { return }
      guard first["state"] as? String == "nobridge" else {
        done(first)
        return
      }
      Provision.ensureBridgeRuntime { ready in
        guard ready else {
          done(["state": "nobridge",
                    // Names the log, not a remedy. There is one provisioner and
                    // it runs itself; whatever stopped it is written down there.
                    "error": "social connections could not start — see ~/.hazlie/logs/bridge-setup.log"])
          return
        }
        self.bridgeCall("POST", "api/bridge/begin", json: ["p": platform], timeout: 30, done)
      }
    }
  }

  // MARK: chat

  // Identity, then the ask. Port 8787 taught this repo that a listener
  // answering 200 proves nothing; the body must be exactly {"ok":true}.
  private func checkHermesIdentity(_ done: @escaping (Bool) -> Void) {
    // 12s, not 3. This probe asks "is this the hermes I trust", and the honest
    // answer while it is mid-compute is "wait" -- but a 3s timeout turned a busy
    // process into a failed identity check, which the caller could not tell from
    // a hostile one. hermes answers /health in 270ms when it is free, so a long
    // ceiling only ever costs time in the case that used to fail outright.
    let req = request("GET", hermesBase, "health", bearer: nil, timeout: 12)
    session.dataTask(with: req) { data, resp, _ in
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
        && data.flatMap { String(data: $0, encoding: .utf8) }?
          .trimmingCharacters(in: .whitespacesAndNewlines) == "{\"ok\":true}"
      done(ok)
    }.resume()
  }

  private func relHermes(_ method: String, _ path: String, json: [String: Any]?,
                         _ done: @escaping ([String: Any]) -> Void) {
    guard let tok = bearerToken() else { done(["state": "auth"]); return }
    let req = request(method, hermesBase, path, bearer: tok, json: json, timeout: 30)
    let task = session.dataTask(with: req) { data, resp, err in
      guard err == nil, let http = resp as? HTTPURLResponse, http.statusCode == 200,
            let d = data,
            let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
        done(["state": "down"]); return
      }
      var out = obj
      out["state"] = "ok"
      done(out)
    }
    task.resume()
  }

  private func ask(_ utterance: String, _ done: @escaping ([String: Any]) -> Void) {
    let work = Bridge.activeWork.begin("thinking about your question")
    let settle: ([String: Any]) -> Void = { result in
      Bridge.activeWork.finish(work)
      done(result)
    }
    guard !utterance.isEmpty else { settle(["state": "error", "error": "empty"]); return }
    guard let tok = bearerToken() else { settle(["state": "auth"]); return }
    checkHermesIdentity { [weak self] identityOK in
      guard let self else { Bridge.activeWork.finish(work); return }
      guard identityOK else { settle(["state": "identity"]); return }
      // Body is exactly {"utterance": ...}. The client never sends context
      // snippets — evidence selection is the vault's job, on the other side
      // of the corpus boundary.
      let req = self.request(
        "POST", self.hermesBase, "vault/ask",
        bearer: tok, json: ["utterance": utterance])
      let task = self.session.dataTask(with: req) { data, resp, err in
        if let e = err as NSError?, e.code == NSURLErrorCancelled {
          settle(["state": "cancelled"]); return
        }
        guard err == nil, let http = resp as? HTTPURLResponse else {
          settle(["state": "down"]); return
        }
        switch http.statusCode {
        case 200:
          guard let d = data,
                let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                let text = obj["text"] as? String
          else { settle(["state": "error", "error": "unparseable answer"]); return }
          settle(["state": "ok", "text": text, "sources": obj["sources"] as? [String] ?? []])
        case 404: settle(["state": "notready"]) // /vault/ask not landed yet
        case 401, 403: settle(["state": "auth"])
        // THE MODEL IS NOT RUNNING, which is not an app bug and not permanent.
        //
        // Only a transport-level failure reached "down" before, and a refused
        // connection BEHIND hermes is not one -- hermes answered, it just could
        // not reach llama-server. So the honest cases fell to `default:` and the
        // owner was told "something went wrong on this app's side" for a model
        // that was merely restarting. build.sh kickstarts llama-server on every
        // deploy, so this is a state they actually hit.
        //
        // 503 ONLY. This briefly mapped 502 here as well, which was wrong:
        // handleVaultAsk sends 502 for any non-OK answer from a model it DID
        // reach -- a bad key, a model-side 500 -- and telling the owner to wait
        // for something to come back on its own hides a fault that needs them.
        // 502 falls to `default:` deliberately.
        case 503: settle(["state": "down"])
        // REACHED, AND THEN SILENT. The ask carries a 110s ceiling, and until it
        // had a status of its own a model that accepted the connection and never
        // answered arrived as an app bug -- for the one failure where asking
        // again is the whole remedy.
        case 504: settle(["state": "slow"])
        default: settle(["state": "error", "error": "http \(http.statusCode)"])
        }
      }
      self.askTask = task
      task.resume()
    }
  }
}
