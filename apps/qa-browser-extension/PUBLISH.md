# Publishing — WithVibe QA Browser (Chrome Web Store)

## Build the upload package

```bash
pnpm --filter @withvibe/qa-browser-extension package
```

Produces `withvibe-qa-browser-extension.zip` (manifest at the zip root,
icons bundled, source maps stripped) — this is the file you upload.

> `package.json` keeps `"private": true`. That only blocks `npm publish`
> (correct — this is an internal workspace package); it has **no effect** on
> the Chrome Web Store, which takes the zip directly. Leave it as-is.

## One-time setup

- [ ] Chrome Web Store **developer account** (one-time $5 USD registration fee).
- [ ] Decide the publisher (personal vs. a WithVibe Google group/brand account
      — group accounts are recommended so the listing isn't tied to one person).
- [ ] Host a **privacy policy** at a public URL (see `PRIVACY.md` — publish it
      at e.g. `https://withvibe.dev/privacy` or a GitHub Pages URL) and have
      the link ready; it is **required** for this extension's permissions.

## Per-submission

- [ ] Bump `version` in `manifest.json` **and** `package.json` (the Store
      rejects re-uploads of an existing version).
- [ ] `pnpm --filter @withvibe/qa-browser-extension package`
- [ ] Load `dist/` unpacked in Chrome and smoke-test pairing end to end
      against a real env before uploading.
- [ ] Upload the zip in the Developer Dashboard → new item / new version.

## Store listing fields to prepare

- [ ] **Single-purpose description** — e.g. "Lets the WithVibe QA agent drive
      the active tab in your Chrome so automated QA runs in your real browser
      instead of a server-side sidecar."
- [ ] At least one **screenshot** (1280×800 or 640×400) — the popup paired to
      an env is a good one.
- [ ] Category: *Developer Tools*. Language. Visibility (**Unlisted** is a good
      first step — shareable by link without public search/review exposure).
- [ ] Privacy policy URL (required, see below).

## Permission justifications (dashboard requires one per permission)

This extension uses permissions Google treats as sensitive — expect extra
review and be precise:

| Permission        | Justification to enter |
|-------------------|------------------------|
| `debugger`        | Drives the page via the Chrome DevTools Protocol (navigation, input, screenshots) for QA automation of the user's own session. |
| `<all_urls>` host | The QA agent must operate on whatever site the user is testing; the target is not known ahead of time. |
| `tabs`            | Identifies/tracks the single tab the user paired for the session. |
| `scripting`       | Injects the page-driver to read DOM state and dispatch actions. |
| `activeTab`/`storage` | Acts on the user-chosen tab; persists the pairing URL across MV3 service-worker restarts. |

- [ ] **Data-use disclosure (Privacy tab):** declare that the extension
      transmits *website content* (DOM snapshots, screenshots, the active
      tab's URL/title) — only to the user's own WithVibe server via the
      pairing WebSocket, **not sold, not used for ads, no third parties**.
- [ ] Note in the listing: while the agent drives the tab, Chrome shows a
      yellow "extension is debugging this browser" banner. This is a Chrome
      security feature and **cannot be hidden** (the popup already warns the
      user). Reviewers will see it — call it out so it isn't flagged as
      deceptive.

## Notes / gotchas

- `debugger` + `<all_urls>` ⇒ heightened review; first review can take days.
  Unlisted distribution still goes through review but avoids public search.
- The extension is **host-agnostic**: it connects to whatever pairing URL the
  WithVibe server mints, so the same build works for every deployment. (The
  server-side fix that makes that URL correct on domain deploys lives in
  `apps/api` — `API_PUBLIC_URL` fallback + the Traefik `/api/qa-browser/ws/`
  route.)
- The generated `withvibe-qa-browser-extension.zip` is a build artifact —
  don't commit it.
