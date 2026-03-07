const express = require('express');
const path    = require('path');
const config  = require('./config');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ── Simple in-memory cache ────────────────────────────────────────────────────
const _cache = {};
function getCached(key) {
  const item = _cache[key];
  if (!item) return null;
  if (Date.now() - item.ts > config.cache[key]) return null;
  return item.data;
}
function setCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

// ── iCloud Photos ─────────────────────────────────────────────────────────────
async function fetchICloudPhotos(token) {
  const headers = {
    'Content-Type': 'application/json',
    'Origin': 'https://www.icloud.com',
  };
  const body = JSON.stringify({ streamCtag: null });

  // Step 1 — discover which partition this album lives on
  let host = 'sharedstreams.icloud.com';
  const probe = await fetch(`https://${host}/${token}/sharedstreams/webstream`, {
    method: 'POST', headers, body,
  });

  if (probe.status === 330) {
    const redirect = await probe.json();
    host = redirect['X-Apple-MMe-Host'];
  }

  // Step 2 — get the stream photo list
  const streamRes = await fetch(`https://${host}/${token}/sharedstreams/webstream`, {
    method: 'POST', headers, body,
  });
  if (!streamRes.ok) throw new Error(`iCloud stream error: ${streamRes.status}`);
  const streamData = await streamRes.json();
  const photos = streamData.photos || [];
  if (photos.length === 0) return [];

  // Step 3 — get signed CDN URLs for each photo
  const guids = photos.map(p => p.photoGuid);
  const assetRes = await fetch(`https://${host}/${token}/sharedstreams/webasseturls`, {
    method: 'POST', headers,
    body: JSON.stringify({ photoGuids: guids }),
  });
  if (!assetRes.ok) throw new Error(`iCloud asset error: ${assetRes.status}`);
  const assetData = await assetRes.json();
  const items = assetData.items || {};

  // Step 4 — build final URLs, prefer the largest available derivative
  const urls = [];
  for (const photo of photos) {
    const derivatives = photo.derivatives || {};
    // Sort derivatives by fileSize descending → highest quality first
    const sorted = Object.values(derivatives)
      .filter(d => d.checksum && d.fileSize)
      .sort((a, b) => b.fileSize - a.fileSize);

    for (const derivative of sorted) {
      const asset = items[derivative.checksum];
      if (asset?.url_location && asset?.url_path) {
        urls.push(`https://${asset.url_location}${asset.url_path}`);
        break;
      }
    }
  }

  // Shuffle so photos appear in random order each load
  return urls.sort(() => Math.random() - 0.5);
}

app.get('/api/photos', async (req, res) => {
  const cached = getCached('photos');
  if (cached) return res.json(cached);
  try {
    const urls = await fetchICloudPhotos(config.icloudAlbumToken);
    setCache('photos', urls);
    res.json(urls);
  } catch (err) {
    console.error('Photo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Weather (Open-Meteo — no API key required) ────────────────────────────────
const WMO_CODES = {
  0:  { label: 'Clear',           icon: '☀️' },
  1:  { label: 'Mostly Clear',    icon: '🌤️' },
  2:  { label: 'Partly Cloudy',   icon: '⛅' },
  3:  { label: 'Overcast',        icon: '☁️' },
  45: { label: 'Foggy',           icon: '🌫️' },
  48: { label: 'Icy Fog',         icon: '🌫️' },
  51: { label: 'Light Drizzle',   icon: '🌦️' },
  53: { label: 'Drizzle',         icon: '🌦️' },
  55: { label: 'Heavy Drizzle',   icon: '🌧️' },
  61: { label: 'Light Rain',      icon: '🌧️' },
  63: { label: 'Rain',            icon: '🌧️' },
  65: { label: 'Heavy Rain',      icon: '🌧️' },
  71: { label: 'Light Snow',      icon: '🌨️' },
  73: { label: 'Snow',            icon: '❄️' },
  75: { label: 'Heavy Snow',      icon: '❄️' },
  77: { label: 'Snow Grains',     icon: '🌨️' },
  80: { label: 'Showers',         icon: '🌦️' },
  81: { label: 'Rain Showers',    icon: '🌧️' },
  82: { label: 'Violent Showers', icon: '⛈️' },
  85: { label: 'Snow Showers',    icon: '🌨️' },
  86: { label: 'Heavy Snow',      icon: '❄️' },
  95: { label: 'Thunderstorm',    icon: '⛈️' },
  96: { label: 'Hail Storm',      icon: '⛈️' },
  99: { label: 'Heavy Hail',      icon: '⛈️' },
};

function wmo(code) {
  return WMO_CODES[code] ?? { label: 'Unknown', icon: '🌡️' };
}

app.get('/api/weather', async (req, res) => {
  const cached = getCached('weather');
  if (cached) return res.json(cached);
  try {
    const { latitude, longitude, timezone, city } = config.weather;
    const url = `https://api.open-meteo.com/v1/forecast?` + new URLSearchParams({
      latitude, longitude, timezone,
      current: 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m',
      daily:   'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max',
      hourly:  'temperature_2m,weather_code,precipitation_probability',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      forecast_days: 8,
    });

    const r = await fetch(url);
    if (!r.ok) throw new Error(`Weather API error: ${r.status}`);
    const d = await r.json();

    // Group hourly data by date so client can look up any day
    // Open-Meteo returns local-time strings like "2026-02-25T14:00" when timezone is set
    const hourlyByDay = {};
    d.hourly.time.forEach((ts, i) => {
      const [date, timePart] = ts.split('T');
      const hour = parseInt(timePart.split(':')[0]);
      if (!hourlyByDay[date]) hourlyByDay[date] = [];
      hourlyByDay[date].push({
        hour,
        temp:   Math.round(d.hourly.temperature_2m[i]),
        precip: d.hourly.precipitation_probability[i],
        ...wmo(d.hourly.weather_code[i]),
      });
    });

    const data = {
      city,
      temp:     Math.round(d.current.temperature_2m),
      feels:    Math.round(d.current.apparent_temperature),
      humidity: d.current.relative_humidity_2m,
      wind:     Math.round(d.current.wind_speed_10m),
      ...wmo(d.current.weather_code),
      daily: d.daily.time.map((date, i) => ({
        date,
        high:   Math.round(d.daily.temperature_2m_max[i]),
        low:    Math.round(d.daily.temperature_2m_min[i]),
        precip: d.daily.precipitation_probability_max[i],
        ...wmo(d.daily.weather_code[i]),
      })),
      hourlyByDay,
    };

    setCache('weather', data);
    res.json(data);
  } catch (err) {
    console.error('Weather error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar (iCal feeds) ─────────────────────────────────────────────────────
app.get('/api/calendar', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || config.calendarDays, 120);
  const cacheKey = `calendar_${days}`;
  const cached = _cache[cacheKey];
  if (cached && Date.now() - cached.ts < config.cache.calendar) return res.json(cached.data);

  if (config.calendars.length === 0) {
    return res.json({ events: [], unconfigured: true });
  }

  try {
    const IcalExpander = (await import('ical-expander')).default;
    const now     = new Date();
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const allEvents = [];

    for (const cal of config.calendars) {
      try {
        const r = await fetch(cal.url);
        if (!r.ok) { console.error(`Calendar ${cal.name}: HTTP ${r.status}`); continue; }
        const icsText = await r.text();

        const expander = new IcalExpander({ ics: icsText, maxIterationCount: 500 });
        const results  = expander.between(now, endDate);

        const toEvent = (e, start, end) => ({
          title:    e.summary || '(No title)',
          start:    start.toJSDate().toISOString(),
          end:      end?.toJSDate()?.toISOString() ?? null,
          allDay:   start.isDate,
          calendar: cal.name,
          color:    cal.color ?? '#60a5fa',
        });

        for (const e of results.events) {
          allEvents.push(toEvent(e, e.startDate, e.endDate));
        }
        for (const o of results.occurrences) {
          allEvents.push(toEvent(o.item, o.startDate, o.endDate));
        }
      } catch (calErr) {
        console.error(`Calendar ${cal.name} error:`, calErr.message);
      }
    }

    allEvents.sort((a, b) => {
      // Primary: chronological order
      const diff = new Date(a.start) - new Date(b.start);
      if (diff !== 0) return diff;
      // Tiebreak: all-day events before timed events on the same day
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return 0;
    });

    const data = { events: allEvents, unconfigured: false };
    _cache[cacheKey] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Birthdays ────────────────────────────────────────────────────────────────
app.get('/api/birthdays', (req, res) => {
  const birthdays = config.birthdays || [];
  if (birthdays.length === 0) return res.json([]);

  const now = new Date();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const result = birthdays.map(b => {
    const thisYear = new Date(now.getFullYear(), b.month - 1, b.day).getTime();
    let daysUntil = Math.round((thisYear - todayMs) / 86400000);
    if (daysUntil < 0) {
      const nextYear = new Date(now.getFullYear() + 1, b.month - 1, b.day).getTime();
      daysUntil = Math.round((nextYear - todayMs) / 86400000);
    }
    return { name: b.name, month: b.month, day: b.day, daysUntil };
  });

  result.sort((a, b) => a.daysUntil - b.daysUntil);
  res.json(result);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n🖼️  Family display running → http://localhost:${config.port}\n`);
  if (config.calendars.length === 0) {
    console.log('ℹ️  No calendars configured. Edit config.js to add your iCal feeds.\n');
  }
});
