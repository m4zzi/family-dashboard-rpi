// ============================================================
// Family Display — Configuration Template
// Copy this file to config.js and fill in your values.
// config.js is gitignored and will never be committed.
// ============================================================

module.exports = {
  // ── iCloud Shared Album ──────────────────────────────────
  // Token is the fragment after # in your shared album URL
  // e.g. https://www.icloud.com/sharedalbum/#YOURTOKEN
  icloudAlbumToken: 'YOUR_ICLOUD_ALBUM_TOKEN',

  // ── Calendar Feeds ───────────────────────────────────────
  // Add as many calendars as you want.
  //
  // Apple iCloud Calendar:
  //   1. Open Calendar.app → right-click a calendar → Share Calendar
  //   2. Enable "Public Calendar" → copy the URL
  //   3. Replace webcal:// with https://
  //
  // Google Calendar:
  //   1. calendar.google.com → Settings → [Calendar] → Integrate calendar
  //   2. Copy "Secret address in iCal format"
  //
  calendars: [
    // { url: 'https://calendar.google.com/calendar/ical/you%40gmail.com/private-xxx/basic.ics', name: 'Personal', color: '#4285F4' },
    // { url: 'https://calendar.google.com/calendar/ical/familyid%40group.calendar.google.com/private-xxx/basic.ics', name: 'Family', color: '#34A853' },
    // { url: 'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics', name: 'Holidays', color: '#FBBC05' },
    // { url: 'https://p126-caldav.icloud.com/published/2/YOUR_ICLOUD_CAL_TOKEN', name: 'iCloud', color: '#2DD4BF' },
  ],

  // ── Weather ──────────────────────────────────────────────
  weather: {
    latitude:  38.9517,       // your city's latitude
    longitude: -92.3341,      // your city's longitude
    city: 'Columbia',         // display name
    timezone: 'America/Chicago',
  },

  // ── Birthdays ──────────────────────────────────────────────
  // { name: 'Display Name', month: 1-12, day: 1-31 }
  birthdays: [
    // { name: 'Mom', month: 2, day: 25 },
  ],

  // ── Display Settings ─────────────────────────────────────
  photoInterval:  30000,  // ms between photo transitions (30s)
  calendarDays:   14,     // how many days ahead to show events
  port:           3000,

  // Cache durations (milliseconds)
  cache: {
    photos:   60 * 60 * 1000,   // 1 hour
    weather:  15 * 60 * 1000,   // 15 minutes
    calendar:  5 * 60 * 1000,   // 5 minutes
  },

  // ── Meural digital frames (OPTIONAL — required by meural-push.js) ─────────
  // Credentials for your Netgear Meural account (Cognito auth) plus the frames
  // to push to. Placeholders only — real values go in config.js, never here.
  // meural: {
  //   email:           'you@example.com',
  //   password:        'YOUR_MEURAL_PASSWORD',
  //   cognitoClientId: '487bd4kvb1fnop6mbgk8gu5ibf',  // Meural's public Cognito app client
  //   cognitoRegion:   'eu-west-1',
  //   galleryName:     'Dashboard',        // cloud gallery managed by the nightly backup run
  //   devices: [
  //     { id: 12345, name: 'frame-1', ip: '192.168.x.x' },
  //     { id: 67890, name: 'frame-2', ip: '192.168.x.x' },
  //   ],
  //   chromiumPath: '/usr/bin/chromium',   // Pi only — system Chromium for puppeteer-core
  //   portraitUrl:  'http://localhost:3000',  // base URL for portrait screenshots (omit for default)
  // },

  // ── Monitoring heartbeat (OPTIONAL) ──────────────────────────────────────
  // If set, meural-push.js POSTs here after each push run
  // (Gatus external-endpoints with a heartbeat window — silence = alert).
  // framesPushUrl = did the postcard reach every frame (PRIMARY heartbeat);
  // pushUrl       = nightly cloud gallery backup result (cloudOk).
  // gatus: {
  //   framesPushUrl: 'http://<gatus-host>:3001/api/v1/endpoints/<group>_<frames-name>/external?success=true',
  //   pushUrl:       'http://<gatus-host>:3001/api/v1/endpoints/<group>_<cloud-name>/external?success=true',
  //   token:         '<bearer token>',
  // },

  // ── Baby-cam overlay (OPTIONAL) ───────────────────────────────────────────
  // Leave this out entirely to disable the feature (the FAB stays hidden).
  // Streams are served by a local go2rtc bound to 127.0.0.1 on the Pi (install
  // separately); the actual camera RTSP URLs live ONLY in ~/go2rtc.yaml on the
  // Pi, never here. `id` must match a stream name in that go2rtc config.
  // babycam: {
  //   port: 1984,            // go2rtc API port (localhost)
  //   autoCloseHours: 2,     // overlay auto-closes after this long
  //   cameras: [
  //     { id: 'baby_cam',  label: 'Baby Cam'  },
  //     { id: 'lyla_room', label: 'Lyla Room' },
  //   ],
  // },
};
