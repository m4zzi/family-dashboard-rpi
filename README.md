# Family Dashboard for Raspberry Pi

A full-screen family display built for a Raspberry Pi. Shows a rotating iCloud photo slideshow as the background with a live clock, weather, and upcoming calendar events layered on top — designed to replace DakBoard with something more personal and fully self-hosted.

![Stack: Node.js + Express + Vanilla JS](https://img.shields.io/badge/stack-Node.js%20%2B%20Vanilla%20JS-brightgreen)

## Features

- **Family photos** — pulls from an iCloud Shared Album, rotates every 30s with a cinematic 2.8s cross-fade; photo counter dots shown bottom-right
- **Live clock** — large Cormorant Garamond serif, updates every second
- **Weather** — current conditions + 3-day forecast strip; tap to open an 8-day detail modal with hourly breakdown per day via [Open-Meteo](https://open-meteo.com/) (free, no API key)
- **Calendar strip** — upcoming events from any iCal feed (Google Calendar, Apple iCloud, or both), swipe left/right between days
- **Calendar month view** — floating button opens a full month grid; tap any day to see its events; navigate months with arrow buttons
- **Birthdays** — upcoming birthdays shown as a banner; today's birthday highlighted in amber
- **Warm editorial design** — frosted glass panels, radial vignette, staggered entrance animations, Cormorant Garamond + DM Sans
- **Touch-first** — all scrollable areas use a custom Pointer Events drag handler that works reliably on Linux/Wayland kiosk (CSS native scroll is unreliable in that environment)
- **Kiosk-ready** — Chromium fullscreen autostart on boot via `.desktop` entry, PM2 for server persistence
- **Meural digital frame support** — hourly auto-push of portrait snapshots to Netgear Meural frames (see below)

## Requirements

- Raspberry Pi running Raspberry Pi OS / Debian 13 (trixie)
- Node.js 20 (`sudo apt install nodejs npm`)
- A network connection

## Setup

### 1. Clone and configure

```bash
git clone https://github.com/m4zzi/family-dashboard-rpi.git
cd family-dashboard-rpi
cp config.example.js config.js
```

Edit `config.js` with your details:

```js
module.exports = {
  icloudAlbumToken: 'YOUR_TOKEN',  // fragment after # in shared album URL

  calendars: [
    { url: 'https://...', name: 'Family', color: '#34A853' },
    { url: 'https://...', name: 'Personal', color: '#4285F4' },
    // add as many as you want
  ],

  weather: {
    latitude:  38.9517,
    longitude: -92.3341,
    city: 'Columbia',
    timezone: 'America/Chicago',
  },
};
```

**iCloud album token** — from `https://www.icloud.com/sharedalbum/#THIS_PART`

**Google Calendar iCal URL** — Calendar Settings → Integrate calendar → *Secret address in iCal format*

**Apple iCal URL** — right-click calendar → Share → Public Calendar → copy URL → change `webcal://` to `https://`

### 2. Install and run

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser.

### 3. Autostart on Raspberry Pi (optional)

Install PM2 to keep the server running across reboots:

```bash
sudo npm install -g pm2
pm2 start server.js --name family-display
pm2 save
sudo pm2 startup
```

For Chromium kiosk mode on boot, create `~/.config/autostart/family-display.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Family Display
Exec=chromium --ozone-platform=wayland --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble --password-store=basic --touch-events=enabled --app=http://localhost:3000
```

> **Wayland note** — Raspberry Pi OS Bookworm / Debian 13 runs a Wayland compositor. `--ozone-platform=wayland` is required for Chromium to enter true fullscreen kiosk mode without a title bar clipping the top of the page. Without it, XWayland is used and the window may be offset. `--password-store=basic` suppresses the GNOME keyring dialog on boot. `--touch-events=enabled` ensures touch input is activated on Linux.

## Meural digital frame support

`meural-push.js` takes N portrait screenshots of `/portrait.html` via Puppeteer and pushes them to a Netgear Meural gallery. On each run it clears the previous batch, uploads fresh ones, assigns the gallery to all configured devices, and sends an immediate local postcard push so frames update without waiting for cloud sync.

### Setup

Add a `meural` block to `config.js`:

```js
meural: {
  email:           'your@email.com',
  password:        'yourpassword',
  cognitoClientId: '487bd4kvb1fnop6mbgk8gu5ibf',  // Meural's Cognito app client
  cognitoRegion:   'eu-west-1',
  galleryName:     'Dashboard',
  devices: [
    { id: 44255, name: 'frame-1', ip: '192.168.x.x' },
    { id: 41840, name: 'frame-2', ip: '192.168.x.x' },
  ],
  // Pi-specific — use system Chromium instead of puppeteer's bundled one
  chromiumPath: '/usr/bin/chromium',
  portraitUrl:  'http://localhost:3000',  // omit to use localhost default
},
```

Find your device IDs: log in at [my.meural.netgear.com](https://my.meural.netgear.com) or call `GET /v0/user/devices` with a valid token.

### Running

```bash
# One-off (6 shots)
node meural-push.js 6

# On Mac — uses bundled Chromium
npm install puppeteer --save-dev

# On Pi — uses system Chromium (lighter)
sudo apt install chromium
npm install puppeteer-core --save-dev
```

### Hourly cron on Pi (PM2)

```bash
pm2 start meural-push.js --name meural-push --cron '0 * * * *' --no-autorestart -- 6
pm2 save
```

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `icloudAlbumToken` | — | iCloud Shared Album token |
| `calendars` | `[]` | Array of `{ url, name, color }` iCal feeds |
| `birthdays` | `[]` | Array of `{ name, month, day }` birthdays |
| `weather.latitude` | — | Your city's latitude |
| `weather.longitude` | — | Your city's longitude |
| `weather.city` | — | Display name shown in weather modal |
| `weather.timezone` | — | IANA timezone string |
| `photoInterval` | `30000` | Ms between photo transitions |
| `calendarDays` | `14` | Days ahead shown in the events strip |
| `port` | `3000` | Server port |
| `meural.devices` | `[]` | Array of `{ id, name, ip }` Meural frames |
| `meural.galleryName` | `'Dashboard'` | Cloud gallery name to manage |
| `meural.chromiumPath` | — | Path to system Chromium (Pi only) |
| `meural.portraitUrl` | `http://localhost:3000` | Base URL for portrait screenshots |

## Interactions

| Gesture | Action |
|---------|--------|
| Tap weather block (top right) | Opens 8-day forecast modal |
| Tap a forecast row | Expands hourly weather strip for that day |
| Swipe left/right on hourly strip | Scroll through hours |
| Swipe left/right on events strip | Navigate between days |
| Tap calendar button (bottom right) | Opens month grid modal |
| Tap a day in month grid | Shows that day's events below grid |
| Tap `‹` / `›` in month modal | Navigate months |
| Tap backdrop or ✕ | Close any modal |

## Security note

`config.js` is gitignored and will never be committed. Your iCal URLs contain private tokens — treat them like passwords. They are only fetched server-side; the raw URLs never reach the browser.

## Tech stack

- **Backend**: Node.js 20, Express, [ical-expander](https://github.com/nicmeister/ical-expander)
- **Weather**: [Open-Meteo](https://open-meteo.com/) — free, no account needed
- **Fonts**: [Cormorant Garamond](https://fonts.google.com/specimen/Cormorant+Garamond) + [DM Sans](https://fonts.google.com/specimen/DM+Sans) via Google Fonts
- **Frontend**: Vanilla JS, no build step, no framework
