# Better YouTube — Adblock, HDR, Shorts & Focus

A small Manifest V3 extension for Chromium browsers that removes YouTube video
and feed ads, filters Shorts out of the interface, asks YouTube for HDR playback
when the display and source support it, can switch YouTube's dark theme to a
pure-black AMOLED background, and can turn the site into a distraction-free
Focus mode.

It is designed for Chrome, Helium, and other Chromium-based browsers. There is
no build step and no external service: load the folder as an unpacked extension.

> Better YouTube is an independent project and is not affiliated with YouTube
> or Google.

## Features

- **Video ad blocking** — strips ad breaks from player responses before
  YouTube's player reads them, blocks known ad hosts with declarativeNetRequest,
  and falls back to clicking Skip / muting and fast-forwarding short ads.
- **Feed and menu ad filtering** — removes ad and promotion renderers from
  Home, search, subscriptions, channel, and guide data, with CSS hiding as a
  second line of defence.
- **Shorts filtering** — hides Shorts shelves, tiles, and tabs, and rewrites
  direct `/shorts/<id>` links to normal `/watch?v=<id>` pages.
- **HDR enforcement** — advertises HDR display support to YouTube, detects
  BT.2020 / PQ / HLG streams, optionally pins the best HDR quality, and shows a
  small HDR badge in the player.
- **AMOLED background** — turns YouTube's dark-theme page background pure black
  while keeping menus, text, icons, and controls readable.
- **Focus mode** — hides comments, related videos, live chat, playlists,
  player cards, Premium/sign-in upsells, merch and tickets, and end screens.
  It also removes rounded corners and tightens spacing for a compact layout.
  Home starts with just the search bar and a button to reveal recommendations;
  search hides recommendation shelves and Shorts while keeping direct results.
- **Counters and quick controls** — popup toggles, an options page, and local
  counters for ads and Shorts filtered.

## Install

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome, Helium, or another Chromium browser.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder that contains `manifest.json`
   (the project root).
5. Pin the extension if you want quick access to the popup.
6. Open or reload YouTube.

The extension requires Chromium **111 or newer** (`minimum_chrome_version` in
`manifest.json`).

## Usage

- Click the toolbar icon to toggle **Block ads**, **Filter Shorts**,
  **Force HDR**, **AMOLED background**, and **Focus mode**. Today's counters
  are shown below the toggles.
- Open **Settings** for the full set of options, including aggressive ad
  skipping, HDR quality pinning, the HDR badge, and Shorts link conversion.
- After changing a setting that affects page behaviour or network rules, reload
  the YouTube tab. The options page has a **Reload YouTube tabs** button.
  **AMOLED background** and **Focus mode** apply instantly.
- In Focus mode, Home is reduced to the masthead search bar. Use the floating
  **Show home recommendations** button to reveal the feed for the current visit;
  navigating away or reloading hides it again. Search keeps direct results but
  drops recommendation shelves and Shorts. The watch page hides comments, the
  related sidebar, live chat, playlists, player cards, promos, and end screens,
  and uses a square, compact layout.
- Settings are stored in `chrome.storage.sync` (and mirrored to the page for
  instant startup). Counters stay in `chrome.storage.local` on this device.

## HDR requirements

HDR playback cannot be created by an extension. For an HDR stream to play, all
of these must be true:

- The display supports HDR and HDR is enabled in the operating system
  (Windows HDR, macOS HDR, etc.).
- The browser, GPU, and codec stack support HDR playback.
- The video has an HDR format available from YouTube.

Better YouTube advertises HDR display capabilities through `matchMedia` and
`screen.colorDepth`/`pixelDepth`, then asks the player for the best HDR stream
when one is available. It cannot turn an SDR video into HDR or bypass device
and DRM limitations.

If colours look washed out or too bright, turn off **Force HDR** in the popup
or options page. HDR on an SDR display can look worse than normal playback.

## How it works

| Layer | Files | Responsibility |
| --- | --- | --- |
| Network | `rules/ads.json`, `rules/shorts.json` | Blocks known ad hosts and ad video requests; redirects direct Shorts URLs. |
| Main world | `src/main.js`, `lib/sanitize.js` | Hooks `fetch`, XHR, and YouTube globals; strips ad fields/renderers; spoofs HDR capability; pins HDR quality. |
| Isolated world | `src/content.js`, `lib/config.js`, `src/content.css` | Applies filter, AMOLED, and Focus classes; hides ad/Shorts elements; filters Focus sections; manages the Home reveal button; handles the ad-skip fallback; consumes Shorts redirect markers; renders the HDR badge; and reports counters. |
| Background | `src/background.js` | Keeps the DNR rulesets in sync with settings and serializes counter writes. |
| UI | `popup/`, `options/`, `src/ui.css` | Quick toggles, full settings, and statistics. |

The `ads` and `shorts_redirect` rulesets are enabled and disabled dynamically
from the saved settings. The content scripts run at `document_start`; the main
world script runs before YouTube's player code so it can scrub responses before
they are consumed.

### Permissions and privacy

- `storage` — saves settings and local counters.
- `declarativeNetRequest` — applies the static ad and Shorts redirect rules.
- `*://youtube.com/*`, `*://*.youtube.com/*` — injects the content scripts on
  YouTube pages.

The extension does not collect analytics, make remote requests, or send data
anywhere. Settings may sync through the browser's own sync service if browser
sync is enabled; counters remain local.

## Project layout

```text
manifest.json             MV3 manifest
lib/config.js             Shared defaults, selectors, settings/stats helpers
lib/sanitize.js           Pure ad-stripping and HDR-detection helpers
src/main.js               MAIN-world hooks, HDR spoofing, quality pinning
src/content.js            ISOLATED-world DOM filtering, Focus mode, stats, badge
src/content.css           Ad/Shorts/Focus hiding, AMOLED, Home button, HDR badge
src/background.js         Ruleset sync and counter persistence
src/ui.css                Shared popup/options styling
rules/ads.json            Network ad rules
rules/shorts.json         Shorts main-frame redirect rule
popup/                    Toolbar popup
options/                  Full settings page
test/                     Node unit tests for the pure helpers
tools/check.mjs           Manifest/file/syntax validation
tools/make-icons.ps1      Regenerates the PNG icons
```

## Development

The project has no runtime dependencies. Node is only needed for the checks.

```bash
npm test
npm run check
npm run icons
```

- `npm test` runs the Node test suite for `lib/sanitize.js` and
  `lib/config.js`.
- `npm run check` validates the manifest, referenced files, JavaScript syntax,
  CSS/HTML structure, and the DNR rules.
- `npm run icons` regenerates the icon PNGs with PowerShell.

After editing the extension, click **Reload** on its card in
`chrome://extensions`, then reload any open YouTube tabs. Loading the project
root with **Load unpacked** is the only setup step.

## Troubleshooting

### Ads still appear

- Make sure **Block ads** is on in the popup or options page.
- Reload the extension and then reload YouTube. Network rulesets are applied
  when the background worker syncs settings.
- Check `chrome://extensions` for an extension error. Invalid DNR rules prevent
  the ruleset from loading.
- Server-stitched ads can still appear briefly; the fallback mutes and
  fast-forwards short clips. If playback breaks, turn off **Aggressive ad
  skipping** first.
- Other blockers can be left installed, but when testing Better YouTube alone,
  disable them (for example, uBlock Origin) and reload YouTube.

### HDR badge is missing or HDR is not selected

- Check that **Force HDR** and **Show HDR badge** are enabled.
- Confirm the video actually has an HDR source. Not every 4K video is HDR.
- Enable HDR in the operating system and make sure the browser/GPU supports it.
- Reload the page after changing HDR settings. The badge only appears after the
  player response contains a recognised HDR format.
- If HDR looks wrong, disable **Force HDR**; an SDR display cannot show HDR
  correctly.

### AMOLED background looks unchanged

- AMOLED mode only changes YouTube's dark theme. Open YouTube's profile menu →
  **Appearance** → **Dark theme**, then make sure **AMOLED background** is on.
- The setting applies instantly through the content script. If it still does not
  change, reload the extension on `chrome://extensions` and refresh YouTube.
- Menus and dialogs stay slightly above pure black (`#0a0a0a`) so they remain
  visually distinct from the page.

### Focus mode leaves something visible

- Focus mode applies instantly, but YouTube renders many parts of the page
  lazily. A section that appears after the first scan should be hidden by the
  observer within a moment; if it stays visible, reload YouTube once.
- Home intentionally starts with no feed. Use the **Show home recommendations**
  button to reveal it for the current visit. Navigating away or reloading
  returns Home to the minimal view.
- Search keeps direct video, channel, and playlist results. Recommendation
  shelves, Shorts shelves, related searches, and promoted results are hidden.
- Player info cards and the card button use the `.ytp-cards-*` selectors. If a
  card teaser still appears, YouTube may have renamed those overlay classes.
- YouTube changes renderer names often. If a new promo, merch shelf, player
  card, or recommendation panel appears, its selector may need to be added to
  `src/content.css` or `src/content.js`.

### Shorts still appear

- Reload YouTube after changing **Filter Shorts** or **Convert Shorts links**.
- Shorts layouts change frequently. The extension targets current shelves,
  tiles, lockups, and tabs; a new renderer may need a selector update.
- Direct Shorts links are redirected at the network layer. If another
  extension or a userscript intercepts the navigation first, the redirect may
  not run.

### Counters are not changing

- Counters update after a short delay and are stored locally.
- Daily counters reset when the local calendar day changes; all-time counters
  remain.
- Use **Reset stats** in the options page to clear both.
- Reload the extension if the background worker was reloaded during a session.

## Limitations

- YouTube changes its player and browse data often. Ad fields and renderers
  that are renamed may need updates to `lib/sanitize.js`, the selectors in
  `lib/config.js`, or the CSS.
- Some ads are stitched into the video stream by the server and cannot be
  removed from the data. The fallback can only skip, mute, or fast-forward
  them.
- HDR depends on the display, operating system, browser, and the source
  formats. The extension only advertises capability and requests the best
  available HDR stream.
- The extension is not a general-purpose ad blocker; its network rules are
  scoped to YouTube and the ad hosts used by YouTube.
- Focus mode is DOM-based and follows YouTube's current renderers. New or
  renamed promotion, shelf, player-card, chat, or end-screen elements may need
  selector updates.
- The counters are an approximation: they count ad breaks and feed ads removed,
  Shorts tiles/shelves hidden, and Shorts links redirected. They are not a
  billing or audit record.
