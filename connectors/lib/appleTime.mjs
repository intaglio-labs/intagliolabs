// Apple's stores count time from 2001-01-01T00:00:00Z (the "Apple epoch" /
// Core Data reference date), not 1970. Everything this package hands hermes
// is epoch MILLISECONDS, so the conversions live in one place with the two
// gotchas written down.

// 2001-01-01T00:00:00Z in Unix epoch milliseconds.
export const APPLE_EPOCH_MS = 978_307_200_000;

// chat.db message.date changed units in macOS 10.13: it used to be SECONDS
// since the Apple epoch and became NANOSECONDS. A database migrated across
// that boundary can hold both eras in one column, so the era is sniffed per
// value by magnitude: seconds-era values are ~1e9 today, nanosecond values
// ~1e18, and 1e12 sits between them with centuries of slack on either side
// (1e12 s after 2001 is the year ~33690; 1e12 ns after 2001 is 2001 plus 17
// minutes, before iMessage existed).
export function appleMessageDateToEpochMs(value) {
  if (!Number.isFinite(value)) {
    throw new Error('appleMessageDateToEpochMs requires a finite number');
  }
  if (Math.abs(value) < 1e12) {
    return Math.round(value * 1000) + APPLE_EPOCH_MS; // seconds era
  }
  return Math.round(value / 1e6) + APPLE_EPOCH_MS; // nanoseconds era
}

// Core Data absolute time as the Calendar and AddressBook stores hold it:
// FLOATING-POINT seconds since the Apple epoch, no era ambiguity.
export function appleAbsoluteSecondsToEpochMs(value) {
  if (!Number.isFinite(value)) {
    throw new Error('appleAbsoluteSecondsToEpochMs requires a finite number');
  }
  return Math.round(value * 1000) + APPLE_EPOCH_MS;
}
