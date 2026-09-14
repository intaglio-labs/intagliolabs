import Foundation

// CARRYING THE OWNER'S SETTINGS ACROSS THE RENAME.
//
// The bundle identifier moved from com.hazlie.widget to io.intaglio.widget, and
// UserDefaults is keyed on it. Everything the app remembers about its owner
// therefore lives in a domain the renamed app cannot see:
//
//   HazlieOnboarded        whether they have been through setup at all
//   HazlieConnectorsIntro  whether they have seen the connectors introduction
//   HazlieMonthsView       which year and view the People panel was left on
//   HazlieScale            the widget's size
//   NSWindow Frame …       where they put the window
//
// Without this, the rename greets a long-standing owner with onboarding, a
// re-introduction to connectors they already connected, and a window back in the
// middle of the screen. None of that is data loss -- the corpus lives in
// ~/.hazlie and is path-based, so it is untouched -- but it reads as the app
// having forgotten them, on an upgrade they did not ask for.
//
// AND THE HALF OF THAT SENTENCE THAT STOPPED BEING TRUE THE MOMENT ~/.hazlie
// WENT. "The corpus is untouched" is what makes carrying HazlieOnboarded right,
// and it is a claim about a directory, not about the domain this file reads: a
// defaults domain is a plist in ~/Library/Preferences and outlives any number of
// deleted data homes. On take 1 of the from-scratch OOBE (2026-09-14) a
// pre-rename `com.hazlie.widget` domain met a freshly deleted ~/.hazlie, this
// carried "they are onboarded", the flow never opened, and the card settings
// onboarding is the only writer of were never written -- so hermes answered
// no-cap-configured for ever and the reconnect card never came. So the list is
// now TWO lists: preferences always carry, and everything that asserts a setup
// step is finished carries only while the data home that produced it is still
// there. See carried / carriedWithDataHome.
//
// WHAT THIS CANNOT CARRY: TCC. Full Disk Access, Contacts and Calendar are
// granted to a bundle identifier plus its signature, and macOS deliberately
// gives an application no way to inherit another's grants -- that is the whole
// point of the mechanism. A renamed build is a new app to the OS and must ask
// again. That is a real cost of the rename and belongs in the release note, not
// in a comment nobody reads at the moment it bites.
enum DefaultsMigration {
  /// The domain the app used before the rename.
  static let previousBundleID = "com.hazlie.widget"

  /// Set once the carry-over has run, so it never runs twice -- a second pass
  /// after the owner has deliberately changed a setting would put the old value
  /// back.
  static let migratedKey = "HazlieDefaultsMigratedFrom"

  /// Everything worth carrying. Named explicitly rather than copying the whole
  /// domain: the old domain also holds Apple's own window-state and WebKit keys,
  /// and importing those wholesale is how a rename inherits somebody else's bugs.
  ///
  /// TWO LISTS, because a defaults domain outlives the install that wrote it.
  /// See carriedWithDataHome.
  ///
  /// These are preferences: how big the widget is, whether it moves, where it
  /// sits, which year the People panel was on. Every one of them describes how
  /// the app should LOOK to this person, none of them says a setup step is
  /// finished, and the worst a wrong one can do is show a familiar owner a
  /// window in the wrong place. They carry unconditionally.
  static let carried = [
    "HazlieMonthsView",
    "HazlieScale",
    "HazlieMotion",
    // The owner's explicit "show it anyway" override of the reduce-motion system
    // setting. Losing it silently reverts a choice they had to go and make.
    "HazlieMotionAnyway",
    "HazlieSounds",
    "HazliePerformanceMode",
    "HazlieKeepMacAwake",
    // The per-connector hand-holds. A preference in the sense that matters here:
    // it suppresses a walkthrough, not a setup step, and openOnboarding(resume:)
    // clears it anyway the moment the flow opens — so a first run rewinds these
    // whether they were carried or not.
    "HazlieHandheld",
    "NSWindow Frame HazlieWidget",
  ]

  /// AND THE KEYS WHOSE MEANING IS A CLAIM ABOUT A MACHINE, NOT A PREFERENCE.
  ///
  /// Take 1 of the from-scratch OOBE (2026-09-14) skipped onboarding entirely on
  /// a freshly deleted ~/.hazlie, because a `com.hazlie.widget` domain left by an
  /// install from before the 30 August rename still said HazlieOnboarded, and
  /// this carried it. UserDefaults survives a data home being deleted — the
  /// domain is a plist in ~/Library/Preferences, the corpus is a directory — so
  /// "they have been through setup" arrived on a machine where setup had never
  /// produced anything.
  ///
  /// What that costs is not cosmetic. Onboarding is the only writer of the
  /// owner's card settings (`POST /admin/config/card {capPerDay:1,
  /// producer:'eligibility'}`, from Bridge.startReadingSources), so a skipped
  /// flow leaves hermes answering `no-cap-configured` for ever and the reconnect
  /// card — the product — never appears. The reader also starts against a `{}`
  /// config with nothing having asked for a permission.
  ///
  /// So these carry ONLY when the data home that legacy install produced is
  /// still there. `~/.hazlie` is path-based rather than bundle-keyed, so the old
  /// install's home and this one's are the same directory, and
  /// `~/.hazlie/connectors/config.json` existing is a truthful answer to "is that
  /// install still here" — as long as the question is asked BEFORE
  /// Provision.ensureConnectorDefaults() writes one. It is: main.swift runs this
  /// at the top of applicationDidFinishLaunching, above the provisioning.
  static let carriedWithDataHome = [
    "HazlieOnboarded",
    "HazlieOnboardingRevision",
    // Which onboarding scene was up. Inert once HazlieOnboarded is true, and
    // carried anyway so a half-finished setup resumes where it stopped rather
    // than starting over. With no data home there is no setup to resume, and
    // resuming one at scene 5 skips scenes 1 to 4.
    "HazlieOnboardingStep",
    // "They have met the connectors" — a setup step, and the same rule.
    "HazlieConnectorsIntro",
    // An undelivered one-card-a-day choice. It is set when screen 1's button is
    // pressed and cleared only once hermes has written the settings down, so a
    // rename that drops it strands an owner whose hermes was down for that
    // session: nothing retries, capPerDay stays absent, and the reconnect card
    // never appears. False on a fresh domain, which is the correct reading for
    // an install that has nothing pending.
    "HazlieCardDefaultsPending",
    // THE SAME RULE, FOR THE OTHER UNDELIVERED CHOICE. The mode the owner
    // picked on screen 1 is written here the moment the button is pressed and
    // cleared only when hermes answers persisted:true, so a rename that drops
    // it strands exactly the owner whose hermes was down that session: the
    // retry ladder has nothing left to re-deliver and their pick is silently
    // 'any' for ever. The launch counter travels with it, because carrying the
    // request without its ceiling restarts the eight-launch budget — a value
    // hermes has already refused seven times would get eight more tries on the
    // strength of an upgrade.
    "HazlieCardModePending",
    "HazlieCardModeLaunches",
    // An import whose vintage could not be stamped, remembered so a date this
    // app does not know is never used as grounds to refuse the owner's own
    // later export. Losing it on the rename makes installedVintage answer "now"
    // again, and the next import of a genuinely newer file is turned away with
    // no way past it but deleting a file by hand.
    //
    // It is in THIS list because it is a fact about a file: the import it
    // describes lived in the data home, so without that home it refuses a real
    // export on the strength of one that is gone.
    "HazlieUnstampedImports",
  ]
  // The three undelivered-press keys travel together or not at all, which is
  // the other reason the split is drawn here rather than at "does it skip a
  // screen": carrying HazlieCardModeLaunches on its own would hand a NEW press
  // a retry budget somebody else had already spent.

  /// Is the install that wrote the old domain still on this Mac?
  ///
  /// Read once, at the call site, rather than inside the pure function below --
  /// so the decision is testable and the timing is visible where it matters.
  static var legacyDataHomePresent: Bool {
    let config = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hazlie/connectors/config.json")
    return FileManager.default.fileExists(atPath: config.path)
  }

  /// Copy the previous bundle's settings in, once, if this bundle has none of
  /// its own. Safe to call on every launch.
  @discardableResult
  static func runIfNeeded(
    into destination: UserDefaults = .standard,
    from sourceName: String = previousBundleID,
    dataHomePresent: Bool = legacyDataHomePresent
  ) -> Int {
    // Already done. Recorded rather than inferred, because "the destination is
    // empty" stops being true the moment the owner changes one setting -- and an
    // owner who deliberately re-ran onboarding must not have the old answer
    // pushed back over it on the next launch.
    if destination.string(forKey: migratedKey) != nil { return 0 }
    guard let source = UserDefaults(suiteName: sourceName) else { return 0 }

    var moved = 0
    for key in carried + (dataHomePresent ? carriedWithDataHome : []) {
      // Only what the OLD domain actually has, and only where the NEW one has
      // nothing: a value already set here was set by this app, and it wins.
      guard let value = source.object(forKey: key) else { continue }
      if destination.object(forKey: key) != nil { continue }
      destination.set(value, forKey: key)
      moved += 1
    }
    if !dataHomePresent {
      NSLog("Intaglio Labs: the old domain is here and its data home is not — "
            + "preferences carried, setup state left behind, so onboarding runs")
    }
    // Stamped even when nothing moved, so a fresh install does not re-check the
    // old domain on every launch for the rest of its life.
    //
    // AND STAMPED ON THE NO-DATA-HOME PATH TOO. Once is once: the owner is about
    // to go through onboarding and write these keys for themselves, and a
    // migration that came back on the next launch would put the old answers over
    // the new ones -- which is the thing migratedKey has always existed to stop.
    destination.set(sourceName, forKey: migratedKey)
    return moved
  }
}
