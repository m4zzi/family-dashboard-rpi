# Family Dashboard — Claude Context

## What this is
A full-screen family dashboard running in Chromium kiosk mode on a Raspberry Pi.
Node.js/Express backend serves a vanilla JS frontend. No build step.

## RPi target
- Host: `m4zzi@192.168.2.164`
- OS: Debian 13 (trixie), aarch64
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

## File structure
```
server.js          — Express API + in-memory cache
config.js          — GITIGNORED — all secrets live here
config.example.js  — committed template (no secrets)
public/
  index.html       — dashboard markup
  style.css        — all styles
  app.js           — client-side data fetching + rendering
package.json
```

## API routes
- `GET /api/photos`   — iCloud shared album photos, cache 1hr
- `GET /api/weather`  — Open-Meteo (no API key), cache 15min
- `GET /api/calendar` — iCal feeds via ical-expander, cache 5min

## iCloud photo API flow
1. POST `https://sharedstreams.icloud.com/{token}/sharedstreams/webstream` `{"streamCtag":null}`
2. If HTTP 330 → redirect host is in `X-Apple-MMe-Host` response field
3. Repeat POST to get `photos[]` with `derivatives` — pick derivative with largest `fileSize`
4. POST `webasseturls` with `photoGuids[]` → `items[checksum]{url_location, url_path}`
5. Final URL: `https://{url_location}{url_path}`
- Album token: `B2OJ0DiRHGfgaLJ` (in config.js, not hardcoded in server.js)
- 158 photos confirmed working Feb 2026

## Calendar setup
All 6 feeds configured in `config.js` on the RPi. Feeds:
- **Thomaz** (blue `#4285F4`) — Google personal + iCloud personal
- **Family** (green `#34A853`) — Google family group + iCloud family
- **Home** (orange `#FB923C`) — iCloud Reminders
- **Holidays** (amber `#FBBC05`) — Google US holidays
- `calendarDays: 14` — events shown 14 days ahead
- iCal feeds parsed with `ical-expander` (handles RRULE recurring events)

## Design system
- **Clock/temp font**: Cormorant Garamond (Google Fonts) — editorial serif
- **UI font**: DM Sans (Google Fonts) — warm, not generic like Inter
- **Accent color**: `#F0A500` amber — used for "Today" label and clock/date divider line
- **Glass panels**: `rgba(12,9,6,0.60)` warm-dark + `backdrop-filter: blur(28px)`
- **Text**: `#FFFBF4` warm white (not clinical pure white)
- **Overlays**: radial vignette + directional top/bottom gradients
- **Animations**: `revealUp` stagger on load — left block → weather → events panel
- **Photo transition**: 2.8s cross-fade between two layered `<div>` background elements
- **Event cards**: colored left-border bar (not dot) — color maps to calendar name

## Weather
- Provider: Open-Meteo (free, no API key)
- Location: Columbia MO — lat 38.9517, lon -92.3341, tz America/Chicago
- Units: Fahrenheit, mph
- Shows: current conditions + 3-day forecast strip

## GitHub
- Repo: https://github.com/m4zzi/family-dashboard-rpi
- `config.js` is gitignored — never commit it
- After changes: rsync to RPi → pm2 restart → git commit → git push
