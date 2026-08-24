// Read Calendar and Contacts through THEIR OWN permissions instead of Full Disk
// Access, and print what was read as JSON.
//
// WHY THIS EXISTS. The connectors are Node, and Node cannot call EventKit or the
// Contacts framework, so both sources read the backing sqlite stores directly:
// Calendar.sqlitedb and AddressBook-v22.abcddb. Those files are Full Disk Access
// territory. That is a much larger grant than either source needs -- FDA is
// every file the owner has, handed over so the app can read two of them -- and
// it is the reason a household that only wanted its calendar read was asked for
// the whole disk.
//
// EventKit and Contacts each have their own TCC permission, scoped to exactly
// the data in question, and this app already declares both entitlements and asks
// for them by name during onboarding. This binary is the bridge: a child of the
// app, so TCC attributes its access to the app and its existing grants, and it
// speaks JSON on stdout so the Node side keeps every semantic decision.
//
// IT CARRIES NO ENTITLEMENTS OF ITS OWN, deliberately -- see the signing note in
// build.sh. Given the app's, macOS SIGKILLs it before main(): those are
// restricted entitlements, honoured under a development identity only with an
// embedded provisioning profile, and a bare executable cannot embed one. The
// grants that matter belong to the responsible process regardless, and that is
// the app.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not shape rows, normalise phone
// numbers, pick entity ids or decide windows. calendar.mjs's buildRows() and
// contacts.mjs's normalisation stay the single definition of those things for
// BOTH backends, because two implementations of an entity id is how two backends
// silently stop agreeing about what is the same event.
//
// LOG POLICY (connectors/AGENTS.md): stdout is the data and is read by the
// caller. stderr is counts and reasons ONLY -- never a title, a name, a number
// or an address.

import Foundation
import EventKit
import Contacts

// Apple absolute time: seconds since 2001-01-01 UTC, which is exactly what
// Date.timeIntervalSinceReferenceDate returns and exactly what the sqlite
// backend's columns hold. The two backends therefore need no conversion between
// them, and buildRows() can consume either without knowing which it got.
private func appleSeconds(_ date: Date?) -> Double? {
  guard let date else { return nil }
  return date.timeIntervalSinceReferenceDate
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data(("apple-data: " + message + "\n").utf8))
  exit(code)
}

private func emit(_ value: Any) -> Never {
  guard JSONSerialization.isValidJSONObject(value),
        let data = try? JSONSerialization.data(withJSONObject: value) else {
    fail("could not serialise the result")
  }
  FileHandle.standardOutput.write(data)
  exit(0)
}

// MARK: - calendar

// EventKit's own event window. Asked for a decade at once it gets slow and, on
// some stores, lossy -- so the span is walked a year at a time and the results
// concatenated. Chunking is invisible to the caller: an occurrence belongs to
// whichever chunk contains its start, and buildRows() cuts the real window
// afterwards anyway.
private let chunk: TimeInterval = 365 * 24 * 60 * 60

private func dumpEvents(fromSeconds: Double, toSeconds: Double) -> Never {
  let store = EKEventStore()
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  var authError: Error?
  let handler: (Bool, Error?) -> Void = { ok, err in
    granted = ok
    authError = err
    sem.signal()
  }
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents(completion: handler)
  } else {
    store.requestAccess(to: .event, completion: handler)
  }
  sem.wait()
  guard granted else {
    // Exit 2 means "not permitted", which the caller reports as this source
    // needing its own grant. Distinct from exit 1 so a denial is never confused
    // with a helper that broke.
    fail("calendar access not granted\(authError.map { ": \($0.localizedDescription)" } ?? "")", code: 2)
  }

  let calendars = store.calendars(for: .event)
  guard !calendars.isEmpty else { emit([]) }

  var out: [[String: Any]] = []
  var start = Date(timeIntervalSinceReferenceDate: fromSeconds)
  let end = Date(timeIntervalSinceReferenceDate: toSeconds)
  while start < end {
    let stop = min(start.addingTimeInterval(chunk), end)
    let predicate = store.predicateForEvents(withStart: start, end: stop, calendars: calendars)
    for event in store.events(matching: predicate) {
      // The external identifier is the UID shared by every occurrence of a
      // recurring event, which is the same identity the sqlite backend's UID
      // column carries. calendarItemIdentifier is per-instance and would give
      // every occurrence its own entity, so it is only a fallback.
      let uid = event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier
      guard let startDate = event.startDate else { continue }
      var row: [String: Any] = [
        "uid": uid,
        "summary": event.title ?? "",
        "calendarTitle": event.calendar?.title ?? "",
        "occurrenceStart": startDate.timeIntervalSinceReferenceDate,
        "allDay": event.isAllDay,
      ]
      row["occurrenceEnd"] = appleSeconds(event.endDate) ?? NSNull()
      // The occurrence SLOT, which is what the entity id is suffixed with. For a
      // non-recurring event this is the start; EventKit reports it either way.
      row["occurrenceDate"] = appleSeconds(event.occurrenceDate) ?? NSNull()
      // NOTE: no `rrule`. It is optional metadata, and EventKit hands back
      // structured EKRecurrenceRule objects rather than the RFC 5545 string the
      // sqlite column holds. Re-serialising one would mean inventing a string
      // that no store ever contained, so this omits the field instead.
      out.append(row)
    }
    start = stop
  }
  FileHandle.standardError.write(Data("apple-data: events=\(out.count)\n".utf8))
  emit(out)
}

// MARK: - contacts

private func dumpContacts() -> Never {
  let store = CNContactStore()
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  var authError: Error?
  store.requestAccess(for: .contacts) { ok, err in
    granted = ok
    authError = err
    sem.signal()
  }
  sem.wait()
  guard granted else {
    fail("contacts access not granted\(authError.map { ": \($0.localizedDescription)" } ?? "")", code: 2)
  }

  let keys: [CNKeyDescriptor] = [
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
  ]
  let request = CNContactFetchRequest(keysToFetch: keys)
  var out: [[String: Any]] = []
  do {
    try store.enumerateContacts(with: request) { contact, _ in
      // A company card has no personal name and its organisation IS its name;
      // without this those contacts arrive blank and are dropped by the caller.
      let display = CNContactFormatter.string(from: contact, style: .fullName)
        ?? (contact.organizationName.isEmpty ? nil : contact.organizationName)
      guard let display, !display.isEmpty else { return }
      let phones = contact.phoneNumbers.map { $0.value.stringValue }
      let emails = contact.emailAddresses.map { $0.value as String }
      guard !phones.isEmpty || !emails.isEmpty else { return }
      // RAW, not normalised. contacts.mjs owns the phone normalisation for both
      // backends -- see the header.
      out.append(["displayName": display, "phones": phones, "emails": emails])
    }
  } catch {
    fail("enumerating contacts failed: \(error.localizedDescription)")
  }
  FileHandle.standardError.write(Data("apple-data: contacts=\(out.count)\n".utf8))
  emit(out)
}

// MARK: - entry

let args = Array(CommandLine.arguments.dropFirst())
func value(_ flag: String) -> Double? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return Double(args[i + 1])
}

switch args.first {
case "events":
  guard let from = value("--from"), let to = value("--to"), from <= to else {
    fail("usage: apple-data events --from <apple-seconds> --to <apple-seconds>")
  }
  dumpEvents(fromSeconds: from, toSeconds: to)
case "contacts":
  dumpContacts()
default:
  fail("usage: apple-data (events --from N --to N | contacts)")
}
