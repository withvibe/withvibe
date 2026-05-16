# Privacy Policy — WithVibe QA Browser

_Last updated: 2026-05-16_

> Draft. Review with whoever owns withvibe.dev legal/brand, then publish at a
> stable public URL and link it in the Chrome Web Store listing.

The **WithVibe QA Browser** extension lets the WithVibe QA agent drive a tab
in your own Chrome so automated QA runs in your real browser instead of a
server-side sidecar. The extension only does anything after you explicitly
paste a one-time pairing URL and click Connect.

## What it accesses

While paired to an environment, in the single tab you paired:

- The page's URL and title.
- DOM content and structure (to locate elements and read state).
- Screenshots of the page.
- Simulated input (clicks, typing, navigation) issued by the QA agent.

It does **not** read other tabs, your browsing history, cookies, passwords,
or form data beyond the active QA session, and it does nothing when not
paired.

## Where the data goes

Captured page content, screenshots, and the active tab's URL/title are sent
over the pairing WebSocket **only to the WithVibe server you paired with**
(an instance you or your organization operate). The data is used solely to
perform the QA automation you requested.

We do **not**:

- Sell or rent your data.
- Use it for advertising or profiling.
- Send it to any third party or to WithVibe-operated servers (unless the
  WithVibe server you paired with is itself one you chose to use).

## Storage

The only data the extension stores locally (via `chrome.storage.local`) is
the most recent pairing URL, so the connection can resume after Chrome
restarts the extension's background worker. Clear it any time with
**Disconnect** in the popup or by removing the extension.

## Permissions

`debugger`, `scripting`, `<all_urls>`, `tabs`, `activeTab`, `storage` are
used strictly to perform automation on the tab you pair for a QA session.
See the listing's permission justifications for detail.

## Contact

Questions: <support@withvibe.dev> _(confirm/replace before publishing)_.
