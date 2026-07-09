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
  /Users/thomazdesouza/Documents/Projects/coffee-display/ \
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
meural-diag.js     — Meural /items upload diagnostic
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
> **Operations runbook: [`MEURAL.md`](MEURAL.md)** — the two delivery paths, the three failure modes + how to tell them apart, and the postcard-resilience design. Read that first when a frame shows the wrong thing.

`meural-push.js` runs on the Pi every 15 min via PM2 cron (`*/15 5-22 * * *`, 5am–10pm). **The local postcard is the live display (primary); the cloud gallery is a nightly backup/fallback** — see [`MEURAL.md`](MEURAL.md) for the full model. Every run:
1. Cognito auth → pin `previewDuration`/`imageDuration` to 24h so the postcard holds
2. Take N screenshots of `/portrait.html` via Puppeteer (waits for `data-ready`)
3. **Postcard each frame** (`http://{device.ip}/remote/postcard`) = the live display, cloud-independent
4. Heartbeat `framesOk` (did the postcard reach both frames)

The **22:00 run only** (or a manual `resync` arg) additionally touches the cloud: find/dedup the "Dashboard" gallery, one upload probe (first 500 ⇒ back off), delete yesterday's item, full frame resync (re-attach gallery + `change_gallery`), heartbeat `cloudOk`.

> Cloud work is nightly-gated because **any cloud item add/delete syncs to the frames and kicks them out of the postcard preview** — per-run uploads had them popping random gallery art all day (mode #4 in MEURAL.md, surfaced 2026-07-03 when Meural's `/items` recovered from its 6/15 outage). The per-run assign-gallery + sync was removed earlier (2026-06-18) for the related stale-pin race.

- Run manually: `node meural-push.js` (optional arg = screenshot count, default 1)
- Logs: `pm2 logs meural-push`
- Uses `puppeteer-core` + system `/usr/bin/chromium` on Pi; `puppeteer` on Mac
- Config: `config.js` → `meural` block (`email`, `password`, `devices`, `chromiumPath`, `portraitUrl`) + `gatus` block (heartbeat URLs)

### Call architecture
- **Postcard (primary, live display)** → direct HTTP `POST http://{device.ip}/remote/postcard` on the local network — no cloud, no auth, no size limit
- **Gallery management** (auth, create/clear gallery, upload items, sync) → Meural cloud API at `api.meural.com/v0` — backup path only; currently broken on `/items` (mode #2)
- All `/remote/...` local device endpoints need no auth and work whenever the frame is powered + on-network (verified against the `ha-meural`/`pymeural` client)

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
- **Node fetches fail (`fetch failed`/`ETIMEDOUT`) while curl works — weather/calendar stale, meural-push fatals at auth:** broken IPv6 (router advertises ULA-only `fd…` prefix, no v6 internet; Node tries AAAA first, curl falls back to v4). Both `server.js` and `meural-push.js` pin `dns.setDefaultResultOrder('ipv4first')` at the top — keep that line if refactoring. Full diagnosis: MEURAL.md failure mode #5. (2026-07-09)
- **Meural frame shows stale images (old date/weather):** postcard push is failing for that device. Check: (1) `pm2 logs meural-push` — look for `postcard: fetch failed` or timeout on that device; (2) ping the device IP from the Pi — `ping 192.168.3.59`; (3) if unreachable, the frame has dropped off Unifi (known fixed-IP bug on whistler-341) — reboot the frame, it will reconnect on the same IP; (4) run `node meural-push.js 6` manually to push immediately after it reconnects.
- **All frames stale by a day or two + `node meural-push.js` shows `Fatal: Upload failed: 500`:** Meural's **cloud upload API is down** (their side — `POST api.meural.com/v0/items` returns a 500 HTML gateway page for real images; a 1×1 test pixel still 201s, so auth/account are fine, their image-ingestion backend is broken). Not our code. The push now handles this gracefully: cloud upload is **best-effort** (a 500 logs `cloud upload … failed (continuing)` instead of aborting), and the **local postcard** (`http://<frame-ip>/remote/postcard`, bypasses the cloud) always fires — so frames stay current via postcard, and the run does NOT re-pin to the (stale) gallery while the cloud is down. Gallery uploads + `clearOldItems` + nightly resync auto-resume once Meural's `/items` returns 201 again. To check the cloud: `node meural-push.js 1 resync` (plain runs no longer touch the cloud) — `✓ cloud is UP` vs the ⚠ warning. (Diagnosed 2026-06-17; broke ~6/15 19:00; recovered by 7/3.)
- **Frame stuck on a WEEKS-old image, reboot doesn't help, cloud looks fine:** different failure from above — the frame's *local* gallery cache is wedged, hoarding stale snapshots, and is cycling its own junk instead of the current items. Tell-tale: the displayed image no longer exists in the cloud gallery (the push deletes old items each run), and `GET http://<ip>/remote/get_frame_items_by_gallery_json/617125/` returns **more items than the cloud gallery has** (e.g. 24 local vs 6 cloud; the bloated frame also shows low `freeSpace` in `GET api.meural.com/v0/user/devices`). Reboot AND a gallery-bounce (change_gallery to another id and back) both fail to clear it. **Fix:** force a full purge + re-pull — `node meural-push.js 6 resync` (or the Meural cloud API: `DELETE /devices/{id}/galleries/{gal}` → `POST /devices/{id}/sync` → re-add → sync). Verify the frame-local count drops back to match the cloud (6). **Auto-prevention:** the 22:00 run (last cron tick) now runs `resyncDevices()` automatically (`NIGHTLY_RESYNC_HOUR` in `meural-push.js`), so a drifting frame self-heals overnight. (Diagnosed 2026-06-12: the 21" tissot-913 was frozen on a May-24 image for ~3 weeks while the cloud was current the whole time.)
- If the weather modal header appears cut off on the Pi: likely `scrollIntoView` on the current hour card scrolling the modal vertically. Fix: use `strip.scrollLeft = card.offsetLeft - strip.offsetWidth/2 + card.offsetWidth/2` instead of `scrollIntoView`.
- If touch scroll isn't working at all: check `--touch-events=enabled` is in the Chromium autostart.
- If kiosk window has a title bar clipping content: check `--ozone-platform=wayland` is in the autostart and that the session is actually Wayland (`echo $WAYLAND_DISPLAY` should return `wayland-0`).
- If swiping selects text instead of scrolling: `user-select: none` on body should prevent this; also check `overflow: clip` (not `hidden`) on `.events-panel`.

## Baby-cam overlay (kiosk-only — live UniFi cameras)
A tap-to-open fullscreen overlay showing a live baby cam (`public/babycam/` + a FAB; `/api/cameras` endpoint; off unless `config.babycam` is set).
- **Streaming = go2rtc on the Pi** (arm64 binary under pm2 as `go2rtc`, config `~/go2rtc.yaml`), **bound localhost-only** (`127.0.0.1:1984`/`:8555`) so the feed is reachable only from the Pi. Pulls RTSP from the **UNVR (`192.168.2.58:7447`)** (cameras: Baby Cam + Lyla Room, Medium channel). On-demand; one stream at a time (toggle swaps).
- **Meural-safe by design:** the overlay is only in `index.html`; `meural-push.js` screenshots `/portrait.html`, which has no camera → the frames can never capture it.
- Gotchas: go2rtc needs `api.origin: "*"` (dashboard `:3000`→go2rtc `:1984` is cross-origin, else 403); switching cameras requires `vs.ondisconnect()` before setting the new `.src` (VideoRTC won't reconnect otherwise); reload the kiosk via a **Pi reboot** (SSH-launched chromium returns exit 255 but the GUI doesn't always attach to the Wayland seat).
- Full detail: auto-memory `project_babycam`.

## Planned features (not yet implemented)
- **Apple Reminders on portrait** — `/api/reminders` endpoint parses `VTODO` from the existing iCloud Reminders iCal feed; portrait splits bottom area into events (left) + reminders (right) columns
- **Home Assistant local sensors** — `/api/sensors` fetches Aqara temp sensors via `GET http://homeassistant.home/api/states/{entity_id}` with a long-lived Bearer token; show indoor vs outdoor temp on kiosk + portrait; blocked on HA migration to pve2

## GitHub
- Repo: https://github.com/m4zzi/family-dashboard-rpi
- `config.js` is gitignored — never commit it
- After changes: rsync to RPi → browser refresh (+ pm2 restart if server.js changed) → git commit → git push
