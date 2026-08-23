// The two react-native touchpoints the voice core actually uses, shimmed so
// ear.js and voice.js port with one changed import line each. Platform: the
// code only asks "am I web?" — in a WKWebView the answer is yes. Animated:
// voice.js publishes audio levels on Animated.Values for a 60fps meter the
// widget doesn't render; a setValue/getValue holder with listener support
// keeps the contract without pulling a framework.
export const Platform = { OS: 'web' };

class Value {
  constructor(v) { this._value = v; this._listeners = new Map(); this._n = 0; }
  setValue(v) {
    this._value = v;
    for (const fn of this._listeners.values()) { try { fn({ value: v }); } catch {} }
  }
  getValue() { return this._value; }
  addListener(fn) { const id = String(++this._n); this._listeners.set(id, fn); return id; }
  removeListener(id) { this._listeners.delete(id); }
  removeAllListeners() { this._listeners.clear(); }
}
export const Animated = { Value };
