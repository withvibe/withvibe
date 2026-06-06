# README media assets

Drop the recordings here, then uncomment the matching `![...]` line in the
root [`README.md`](../README.md). Filenames below are what the README already
points at — keep them, or update both places.

| File | Type | Where it shows in the README | What to capture |
| --- | --- | --- | --- |
| `hero-live-preview.gif` | GIF, 30–60s, looping | Top, right under the tagline + badges (before "Try it in 30 seconds") | **The core loop / the "wow":** type a request to the AI → a file is saved → the live preview updates instantly. This is the "live app, no deploy" promise. **If you only make one asset, make this one.** |
| `workspace.png` | Screenshot | "The idea" section | One screen showing **chat + live preview + logs together** — proves "one environment, every tool". |
| `agent-gate.gif` | GIF or PNG | "Flow" section, next to the gate diagram | The **agent gate running**: security / code review / tests / policy passing. This is the differentiator — the "safe" half. |

## Tips

- One good GIF beats three screenshots.
- Keep GIFs reasonably sized (aim < ~10 MB) so the README loads fast — trim
  length, crop tight, and cap width around 1200px. Tools: `gifski`, `ffmpeg`,
  Kap, or Gifox.
- Record on a clean, representative env (no secrets, no throwaway names) — the
  hero GIF is the first thing visitors see.
