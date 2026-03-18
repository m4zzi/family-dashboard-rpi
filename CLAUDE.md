# Family Dashboard — Claude Context

## What this is
A full-screen family dashboard running in Chromium kiosk mode on a Raspberry Pi.
Node.js/Express backend serves a vanilla JS frontend. No build step.

## RPi target
- Host: `m4zzi@192.168.2.164`
- OS: Debian 13 (trixie), aarch64, **Wayland session** (labwc compositor)
- Deploy path: `~/family-display/`
- Dashboard URL: http://192.168.2.164:3000
- Process manager: PM2 (`pm2 status`, `pm2 restart family-display`, `pm2 logs family-display`)
- Kiosk autostart: `~/.config/autostart/test.desktop`

## Deploy workflow (from Mac)
```bash
rsync -av --exclude=node_modules --exclude=.git \
  /Users/thomazdesouza/Documents/Projects/claude/coffee-display/ \
  m4zzi@192.168.2.164:~/family-display/
ssh m4zzi@192.168.2.164 "pm2 restart family-display"
```
CSS/JS changes don't need pm2 restart — just rsync + browser refresh.

## Chromium autostart flags (important)
```
chromium --ozone-platform=wayland --kiosk --incognito --noerrdialogs
  --disable-infobars --no-first-run --disable-session-crashed-bubble
  --password-store=basic --touch-events=enabled --app=http://localhost:3000
```
- `--ozone-platform=wayland` — **required** on Debian 13 Wayland; without it Chromium falls back to XWayland and the kiosk window may have a title bar that clips the top of the page content
- `--password-store=basic` — suppresses GNOME keyring dialog on boot
- `--touch-events=enabled` — activates touch input on Linux

## File structure
```
server.js          — Express API + in-memory cache
config.js          — GITIGNORED — all secrets live here
config.example.js  — committed template (no secrets)
meural-push.js     — Puppeteer screenshot + Meural cloud upload script
public/
  index.html       — dashboard markup (kiosk)
  style.css        — kiosk styles
  app.js           — client-side data fetching + rendering (kiosk)
  portrait.html    — Meural portrait layout (1080×1920 static snapshot)
  portrait.css     — portrait styles — no glass, editorial, photo-as-hero
  portrait.js      — portrait data fetching; sets data-ready for Puppeteer
package.json
```

## API routes
- `GET /api/photos`          — iCloud shared album photos, cache 1hr
- `GET /api/weather`         — Open-Meteo (no API key), cache 15min; includes `hourlyByDay` map
- `GET /api/calendar?days=N` — iCal feeds via ical-expander, cache 5min; default N=14
- `GET /api/birthdays`       — birthday list from config.js, returns daysUntil for each

## Meural portrait pipeline
`meural-push.js` runs on the Pi hourly via PM2 cron (`0 5-22 * * *`, 5am–10pm):
1. Cognito auth → find/dedup "Dashboard" gallery → clear old items
2. Take N screenshots of `/portrait.html` via Puppeteer (waits for `data-ready`)
3. Upload each to Meural cloud → add to gallery
4. Assign gallery + sync on each device
5. Local postcard push to each device IP for immediate display

- Run manually: `node meural-push.js 6`
- Logs: `pm2 logs meural-push`
- Uses `puppeteer-core` + system `/usr/bin/chromium` on Pi; `puppeteer` on Mac
- Config: `config.js` → `meural` block (`email`, `password`, `devices`, `chromiumPath`, `portraitUrl`)

### Call architecture
- **All gallery management** (auth, create/clear gallery, upload items, assign gallery, sync) → Meural cloud API at `api.meural.com/v0`
- **Postcard only** → direct HTTP to `http://{device.ip}/remote/postcard` on the local network
- Cloud sync is unreliable for timing; the local postcard is the real "show it now" mechanism — if postcard fails, the frame will eventually sync via cloud but may lag by minutes

## iCloud photo API flow
1. POST `https://sharedstreams.icloud.com/{token}/sharedstreams/webstream` `{"streamCtag":null}`
2. If HTTP 330 → redirect host is in `X-Apple-MMe-Host` response field
3. Repeat POST to get `photos[]` with `derivatives` — pick derivative with largest `fileSize`
4. POST `webasseturls` with `photoGuids[]` → `items[checksum]{url_location, url_path}`
5. Final URL: `https://{url_location}{url_path}`
- Album token lives in `config.js` (`icloudAlbumToken`)
- Photos are shuffled on each cache miss

## Calendar setup
All 6 feeds configured in `config.js` on the RPi:
- **Thomaz** (blue `#4285F4`) — Google personal + iCloud personal
- **Family** (green `#34A853`) — Google family group + iCloud family
- **Home** (orange `#FB923C`) — iCloud Reminders
- **Holidays** (amber `#FBBC05`) — Google US holidays
- `calendarDays: 14` — events strip shows 14 days ahead
- Calendar month modal fetches `?days=90` on first open, cached in JS
- iCal feeds parsed with `ical-expander` (handles RRULE recurring events)

## Weather
- Provider: Open-Meteo (free, no API key)
- Location: Columbia MO — lat 38.9517, lon -92.3341, tz America/Chicago
- Units: Fahrenheit, mph
- Server fetches: current + 8 daily + hourly (temp, weather_code, precip_probability)
- `hourlyByDay` — object keyed by `"YYYY-MM-DD"`, each value is array of `{hour, temp, precip, icon, label}`
- Weather modal: 8-day cards, tapping a row expands its hourly strip; today auto-expands on open
- `expandedForecastDate` — global state tracking which row is expanded (only one at a time)

## Touch / scroll implementation (critical for Chromium/Linux kiosk)
CSS native `overflow: auto` scroll does not work reliably on Chromium/Linux Wayland kiosk. All scrollable areas use a custom `attachDragScroll(el, options)` function in `app.js` built on the Pointer Events API.

### attachDragScroll(el, { axis, snapChildSelector, isolated })
- `axis: 'x'` (default) — horizontal scroll using `setPointerCapture` so drag works even if pointer drifts outside element; temporarily disables `scroll-snap-type` during drag for 1:1 tracking, re-enables on release then snaps
- `axis: 'y'` — vertical scroll using **document-level** `pointermove`/`pointerup` listeners instead of `setPointerCapture`; this is intentional — without capture, child click handlers (forecast rows, calendar cells) fire normally
- `snapChildSelector` — on pointerup, snaps to nearest child matching selector (x-axis only)
- `isolated: true` — calls `e.stopPropagation()` on `pointerdown` to prevent a parent element's drag handler from stealing pointer capture (used on the hourly strip inside the weather modal)

### Where it's attached
| Element | axis | isolated | snap |
|---------|------|----------|------|
| `#eventsInner` | x | no | `.day-col` |
| `.hourly-strip` (each instance) | x | **yes** | none |
| `#weatherModal` | y | no | none |
| `#calendarModal` | y | no | none |

### Other scroll-related CSS
- `overflow: clip` on `.events-panel` (not `hidden`) — clips visually without becoming a scroll container that intercepts child scroll gestures
- `user-select: none` on `body` — prevents text selection competing with drag gestures
- `touch-action: pan-x pinch-zoom` on `.events-inner` — hint to browser for horizontal intent

## Design system
- **Clock/temp/day-numbers font**: Cormorant Garamond (Google Fonts) — editorial serif
- **UI font**: DM Sans (Google Fonts) — warm, not generic like Inter
- **Accent color**: `#F0A500` amber — "Today" label, clock/date divider, hover states, current hour highlight
- **Glass panels**: `rgba(12,9,6,0.60)` warm-dark + `backdrop-filter: blur(28px)`
- **Text**: `#FFFBF4` warm white (not clinical pure white)
- **Overlays**: radial vignette (`z-index:2`) + directional top/bottom gradients (`z-index:3`)
- **Animations**: `revealUp` stagger on load; `rowIn` stagger on forecast rows; `gridSlideIn`/`gridSlideInBack` on calendar month navigation
- **Photo transition**: 2.8s cross-fade between two layered `<div>` background elements (`#photoBg1`, `#photoBg2`)
- **Event cards**: colored left-border bar (3px, not dot) — color maps to calendar name

## Known issues / debugging notes
- **Meural frame shows stale images (old date/weather):** postcard push is failing for that device. Check: (1) `pm2 logs meural-push` — look for `postcard: fetch failed` or timeout on that device; (2) ping the device IP from the Pi — `ping 192.168.3.59`; (3) if unreachable, the frame has dropped off Unifi (known fixed-IP bug on whistler-341) — reboot the frame, it will reconnect on the same IP; (4) run `node meural-push.js 6` manually to push immediately after it reconnects.
- If the weather modal header appears cut off on the Pi: likely `scrollIntoView` on the current hour card scrolling the modal vertically. Fix: use `strip.scrollLeft = card.offsetLeft - strip.offsetWidth/2 + card.offsetWidth/2` instead of `scrollIntoView`.
- If touch scroll isn't working at all: check `--touch-events=enabled` is in the Chromium autostart.
- If kiosk window has a title bar clipping content: check `--ozone-platform=wayland` is in the autostart and that the session is actually Wayland (`echo $WAYLAND_DISPLAY` should return `wayland-0`).
- If swiping selects text instead of scrolling: `user-select: none` on body should prevent this; also check `overflow: clip` (not `hidden`) on `.events-panel`.

## Planned features (not yet implemented)
- **Apple Reminders on portrait** — `/api/reminders` endpoint parses `VTODO` from the existing iCloud Reminders iCal feed; portrait splits bottom area into events (left) + reminders (right) columns
- **Home Assistant local sensors** — `/api/sensors` fetches Aqara temp sensors via `GET http://homeassistant.home/api/states/{entity_id}` with a long-lived Bearer token; show indoor vs outdoor temp on kiosk + portrait; blocked on HA migration to pve2

## GitHub
- Repo: https://github.com/m4zzi/family-dashboard-rpi
- `config.js` is gitignored — never commit it
- After changes: rsync to RPi → browser refresh (+ pm2 restart if server.js changed) → git commit → git push
