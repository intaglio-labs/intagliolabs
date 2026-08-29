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
import ImageIO

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


// WHO WAS THERE. An EKParticipant carries a display name and a mailto: URL, and
// the email in that URL is the single best cross-platform join key this corpus
// has: it matches the contacts spine's `email` identifiers directly, which is
// how a calendar event and an iMessage thread become the same person.
//
// A private development calendar confirmed that attendee records frequently
// include email addresses. The stored corpus had carried none of it -- the row
// meta had keys for the event but not one for a person.
//
// isCurrentUser is kept rather than filtered here: the Node side decides whether
// "me" belongs in a row, and a helper that silently drops the owner would make
// "who else was at this" impossible to distinguish from "nobody was".
private func participant(_ p: EKParticipant?) -> [String: Any]? {
  guard let p else { return nil }
  var out: [String: Any] = ["isMe": p.isCurrentUser]
  if let n = p.name, !n.isEmpty { out["name"] = n }
  // mailto:someone@example.com -> someone@example.com. Anything else (a phone
  // participant, an opaque directory URL) contributes no email and is kept for
  // its name alone.
  if p.url.scheme?.lowercased() == "mailto" {
    let raw = p.url.absoluteString
    let addr = String(raw.dropFirst("mailto:".count))
    if !addr.isEmpty { out["email"] = addr }
  }
  switch p.participantStatus {
  case .accepted: out["status"] = "accepted"
  case .declined: out["status"] = "declined"
  case .tentative: out["status"] = "tentative"
  case .pending: out["status"] = "pending"
  default: break
  }
  return out
}

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
      if let location = event.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
        row["location"] = location
      }
      row["occurrenceEnd"] = appleSeconds(event.endDate) ?? NSNull()
      // The occurrence SLOT, which is what the entity id is suffixed with. For a
      // non-recurring event this is the start; EventKit reports it either way.
      row["occurrenceDate"] = appleSeconds(event.occurrenceDate) ?? NSNull()
      // NOTE: no `rrule`. It is optional metadata, and EventKit hands back
      // structured EKRecurrenceRule objects rather than the RFC 5545 string the
      // sqlite column holds. Re-serialising one would mean inventing a string
      // that no store ever contained, so this omits the field instead.
      let people = (event.attendees ?? []).compactMap(participant)
      if !people.isEmpty { row["attendees"] = people }
      if let org = participant(event.organizer) { row["organizer"] = org }
      out.append(row)
    }
    start = stop
  }
  let withPeople = out.filter { ($0["attendees"] as? [[String: Any]])?.isEmpty == false }.count
  FileHandle.standardError.write(Data("apple-data: events=\(out.count) withAttendees=\(withPeople)\n".utf8))
  emit(out)
}

// MARK: - contacts

/// A contact photo, small enough to send 250 of.
///
/// CNContactThumbnailImageData is NOT necessarily small in a real address
/// book. The People page draws photos in tiny circles, so shipping every
/// original wastes memory and bridge bandwidth. ImageIO decodes and resizes in
/// one pass without materialising a second full-size bitmap.
///
/// Returns nil for absent or undecodable input — the caller omits the field,
/// and the face falls back to initials.
// The People list draws these at 20px, but its constellation can zoom to 2.2x
// and its largest faces start much bigger than the list. A 96px source visibly
// softens there even when WebKit rasterizes the UI itself at the right scale.
// 256px keeps the maximum zoom sharp without retaining multi-megabyte contact
// originals; the connector still stores only this bounded local derivative.
private func downscaleJPEG(_ data: Data?, max: CGFloat = 256) -> Data? {
  guard let data, !data.isEmpty else { return nil }
  guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,   // honour EXIF rotation
    kCGImageSourceThumbnailMaxPixelSize: max,
  ]
  guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return out as Data
}

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

  // GRANTED IS NOT THE SAME AS ALL OF THEM.
  //
  // Recent macOS has limited contacts access: the owner picks a subset and the
  // app sees only those. requestAccess reports success for it, enumerateContacts
  // quietly returns the subset, and nothing anywhere says so -- which reads,
  // downstream, as an address book that simply does not contain people the owner
  // knows perfectly well it contains. Reported here so contacts.mjs can log it
  // and the connect page can say it out loud; nothing in this process can widen
  // it, and pretending otherwise is how the last silent failure got shipped.
  var access = "full"
  if #available(macOS 15.0, *) {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .limited: access = "limited"
    case .authorized: access = "full"
    case .denied: access = "denied"
    case .restricted: access = "restricted"
    case .notDetermined: access = "notDetermined"
    @unknown default: access = "unknown"
    }
  }

  let keys: [CNKeyDescriptor] = [
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    // THUMBNAIL, not the full image. CNContactImageDataKey is the original the
    // owner dropped in — often a multi-megabyte photo — and the People page
    // draws it at 26px. The thumbnail is what Contacts.app itself shows in a
    // list, already square and small, so this is the size the product needs
    // rather than a size we would have to resize down ourselves.
    CNContactThumbnailImageDataKey as CNKeyDescriptor,
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
      // base64, because this crosses a pipe as JSON. Absent when the contact
      // has no picture — most do not, and an empty string per contact is a
      // field the reader would have to special-case anyway.
      var row: [String: Any] = [
        "contactId": contact.identifier,
        "displayName": display,
        "phones": phones,
        "emails": emails,
      ]
      if let small = downscaleJPEG(contact.thumbnailImageData) {
        row["thumbnail"] = small.base64EncodedString()
      }
      out.append(row)
    }
  } catch {
    fail("enumerating contacts failed: \(error.localizedDescription)")
  }
  FileHandle.standardError.write(Data("apple-data: contacts=\(out.count) access=\(access)\n".utf8))
  // A marker record rather than a wrapper object, so every existing reader of
  // this array keeps working and only a reader that looks for it sees it.
  out.append(["__access": access])
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
