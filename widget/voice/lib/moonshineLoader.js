// Loads moonshine-js at runtime. The frontend original hid this dynamic
// import from Metro with `new Function`; there is no bundler in the widget,
// so it is a plain literal import the browser resolves against the ear
// page's hazlie-asset:// origin (served natively; nothing is fetched from
// the network).
const VENDOR_URL = '/vendor/moonshine.min.js';

let promise = null;

/** Resolves to the moonshine-js module namespace ({ Transcriber, Settings, ... }).
 *  Loaded once; a failure clears the cache so a retry can succeed. */
export function loadMoonshine() {
  if (!promise) {
    promise = import(VENDOR_URL);
    promise.catch(() => {
      promise = null;
    });
  }
  return promise;
}

export default loadMoonshine;
