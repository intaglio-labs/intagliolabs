// Google OAuth must run in the user's system browser.
//
// This used to render the authorization endpoint in a WKWebView with a Safari
// user-agent. Google explicitly disallows OAuth in developer-controlled
// embedded user-agents, and changing the user-agent does not turn a webview
// into a supported browser. The webview also cancelled the loopback redirect
// in decidePolicyFor, before ops/gcal-auth.mjs could receive the authorization
// code.
//
// The helper still owns the security-sensitive pieces: it binds the loopback
// listener, generates state + PKCE, exchanges the code and writes the token
// owner-only. This type does exactly one thing: hand its fixed Google URL to
// macOS so the default browser can complete that redirect normally.

import AppKit

enum GoogleLogin {
  static func present(url: String, done: @escaping (Bool, String?) -> Void) {
    guard let target = URL(string: url), target.scheme == "https",
          target.host == "accounts.google.com" else {
      done(false, "Google sign-in returned an invalid authorization URL.")
      return
    }
    let opened = NSWorkspace.shared.open(target)
    done(opened, opened ? nil : "Google sign-in could not be opened in your browser.")
  }
}
