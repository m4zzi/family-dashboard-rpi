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
};
