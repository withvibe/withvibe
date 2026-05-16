# @withvibe/qa-browser-extension

Chrome (Manifest V3) extension that lets the WithVibe **QA agent** drive the
active tab in your real browser instead of a Docker-sidecar browser. Useful
when a flow needs your real session, extensions, or local network.

## Build

```bash
pnpm --filter @withvibe/qa-browser-extension build      # dist/
pnpm --filter @withvibe/qa-browser-extension watch      # rebuild on change
pnpm --filter @withvibe/qa-browser-extension package    # zip for the store
```

## Load it locally

1. Build (above) — output lands in `dist/`.
2. Visit `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `apps/qa-browser-extension/dist`.
4. In a WithVibe env, set the QA browser mode to "user browser".

## Privacy

The extension only acts on the tab when a QA session is connected. See
[PRIVACY.md](./PRIVACY.md) for the data-handling details and
[PUBLISH.md](./PUBLISH.md) for the Web Store submission notes.

Licensed under the [Elastic License 2.0](../../LICENSE).
