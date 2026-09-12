// The connector roster, in a leaf module so it can be read without loading the
// daemon.
//
// It lived in daemon.mjs, which resolves the feature registry at module scope
// and builds the whole scheduler. connect/lib/status.mjs needs nothing but the
// names -- it has to know which sources a poll interval can be set for, in
// order to work out how often the daemon republishes its activity file -- and
// importing the daemon to learn twelve strings would drag that side effect into
// every connect request. daemon.mjs re-exports it, so nothing that already
// imports it from there has to change.

// The closed set of connectors this daemon will ever schedule. A sources/
// module whose name is not here is a typo or an unreviewed data source, and
// both must fail loudly at startup rather than quietly begin polling.
export const CONNECTOR_NAMES = Object.freeze([
  'imessage',
  'calendar',
  'mail',
  'granola',
  'oura',
  'photos',
  'notes',
  'contacts',
  'notion',
  'files',
  'whatsapp',
  // The social bridges' DMs, read out of the local Matrix bus. One connector
  // for seven platforms: the row's `source` comes from which bridge's ghost
  // sent it (lib/matrixRows.mjs), so messenger and slack land as themselves.
  'matrix',
  // Back as a second, independent source of `linkedin` rows. The bridge
  // (above) supplies live DMs but not the export's connection metadata
  // (name, position, company, Connected On) or the historical message
  // archive — nothing about a live chat session can produce those. Same
  // hermes source name as the bridge's LinkedIn rows, different entity_id
  // namespace (linkedin:conn:/linkedin:msg: vs the bridge's linkedin:<event
  // id>), so the two coexist without colliding row-for-row. See
  // sources/linkedin.mjs.
  'linkedin',
]);
