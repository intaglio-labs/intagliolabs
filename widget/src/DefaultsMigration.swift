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
  static let carried = [
    "HazlieOnboarded",
    "HazlieOnboardingRevision",
    // Which onboarding scene was up. Inert once HazlieOnboarded is true, and
    // carried anyway so a half-finished setup resumes where it stopped rather
    // than starting over.
    "HazlieOnboardingStep",
    "HazlieConnectorsIntro",
    "HazlieMonthsView",
    "HazlieScale",
    "HazlieMotion",
    // The owner's explicit "show it anyway" override of the reduce-motion system
    // setting. Losing it silently reverts a choice they had to go and make.
    "HazlieMotionAnyway",
    "HazlieSounds",
    "HazliePerformanceMode",
    "HazlieKeepMacAwake",
    "HazlieHandheld",
    "NSWindow Frame HazlieWidget",
  ]

  /// Copy the previous bundle's settings in, once, if this bundle has none of
  /// its own. Safe to call on every launch.
  @discardableResult
  static func runIfNeeded(
    into destination: UserDefaults = .standard,
    from sourceName: String = previousBundleID
  ) -> Int {
    // Already done. Recorded rather than inferred, because "the destination is
    // empty" stops being true the moment the owner changes one setting -- and an
    // owner who deliberately re-ran onboarding must not have the old answer
    // pushed back over it on the next launch.
    if destination.string(forKey: migratedKey) != nil { return 0 }
    guard let source = UserDefaults(suiteName: sourceName) else { return 0 }

    var moved = 0
    for key in carried {
      // Only what the OLD domain actually has, and only where the NEW one has
      // nothing: a value already set here was set by this app, and it wins.
      guard let value = source.object(forKey: key) else { continue }
      if destination.object(forKey: key) != nil { continue }
      destination.set(value, forKey: key)
      moved += 1
    }
    // Stamped even when nothing moved, so a fresh install does not re-check the
    // old domain on every launch for the rest of its life.
    destination.set(sourceName, forKey: migratedKey)
    return moved
  }
}
