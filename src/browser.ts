// The browser surface the monitor needs.
//
// It is a subset of the X reply engine's XBrowser in nextbrowser-app
// (src/lib/xreply/browser.ts), so the app can hand the monitor the same
// nextctl-backed browser it already builds for a prepared profile. Outside the
// app, src/node/nbc.ts implements it over the nbc CLI.
//
// Instagram is read through the JSON endpoints its own web app calls, fetched
// from an instagram.com tab with the profile's cookies, so the monitor needs no
// clicks, no scrolling and no waiting for elements: a tab on the site and a way
// to evaluate a script.
//
// Nothing here may depend on Node: the app runs its engines in the renderer.

export interface MonitorBrowser {
  /** Navigate the active tab. */
  open(url: string): Promise<void>;
  /** Evaluate one expression on the active page and return its value. The
   *  expression may be a promise: nbc evaluates with awaitPromise. The label
   *  names the read in logs and lets test fakes route by it. */
  evaluate<T>(script: string, label?: string): Promise<T>;
  /** Wait until the active page finishes loading. */
  waitForLoad(timeoutSeconds?: number): Promise<void>;
}
