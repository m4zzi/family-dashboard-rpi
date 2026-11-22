const express = require('express');
const path    = require('path');
const { randomUUID } = require('node:crypto');
// Prefer IPv4: the Pi has a ULA-only IPv6 (no v6 internet), and Node's fetch tries
// AAAA first and times out — weather/calendar/iCloud fetches all intermittently
// failed this way (2026-07). See the matching note in meural-push.js.
require('dns').setDefaultResultOrder('ipv4first');
// Only the running dashboard needs the local configuration.
const config = require.main === module ? require('./config') : undefined;

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

function parseAlbumGuid(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  const match = /^https:\/\/photos\.icloud\.com\/shared\/album\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(input);
  if (!match) throw new Error('Invalid iCloud shared album URL or shortGUID');
  return match[1];
}

function jpegRendition(fields, slot) {
  const prefix = 'res' + slot;
  const fileType = fields[prefix + 'FileType']?.value;
  if ((slot === 'Original' || fileType != null) && fileType !== 'public.jpeg') return null;
  const url = fields[prefix + 'Res']?.value?.downloadURL;
  const width = Number(fields[prefix + 'Width']?.value);
  const height = Number(fields[prefix + 'Height']?.value);
  if (typeof url !== 'string' || !url || !(width > 0 && height > 0)) return null;
  return { url: url.replaceAll('${f}', 'public.jpeg'), width, height };
}

const assetJpegSlots = ['JPEGThumb', 'JPEGMed', 'JPEGLarge', 'JPEGFull'];
const masterJpegSlots = [...assetJpegSlots, 'Original'];

function selectJpegRendition(fields, slots) {
  const renditions = slots
    .map(slot => jpegRendition(fields, slot))
    .filter(Boolean)
    .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return renditions.find(r => Math.max(r.width, r.height) >= 1920) ?? renditions.at(-1);
}

function photosFromRecords(records) {
  const masters = new Map(records
    .filter(r => r.recordType === 'CPLMaster' && r.recordName)
    .map(r => [r.recordName, r]));
  const photos = [];
  for (const asset of records) {
    if (asset.recordType !== 'CPLAsset' || !asset.recordName) continue;
    const master = masters.get(asset.fields?.masterRef?.value?.recordName);
    if (!master?.fields || Number(master.fields.dataClassType?.value) === 2) continue;
    const photo = selectJpegRendition(asset.fields, assetJpegSlots)
      ?? selectJpegRendition(master.fields, masterJpegSlots);
    if (photo) photos.push({ id: asset.recordName, ...photo });
  }
  return photos;
}

function filterPhotosByOrientation(photos, orientation) {
  if (orientation !== 'landscape' && orientation !== 'portrait') return photos;
  const matching = photos.filter(({ width, height }) =>
    orientation === 'landscape' ? width >= height : height >= width);
  return matching.length ? matching : photos;
}

async function fetchSharedAlbumPhotos(albumUrl) {
  const guid = parseAlbumGuid(albumUrl);
  const database = '/database/1/com.apple.photos.cloud/production';
  const params = new URLSearchParams({
    remapEnums: 'true', getCurrentSyncToken: 'true', sharing_url_key: guid,
    clientBuildNumber: '2642Build18', clientMasteringNumber: '2642Build18',
  });

  async function post(url, contentType, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://photos.icloud.com', 'Content-Type': contentType },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`iCloud shared album error: HTTP ${response.status}`);
    return response.json();
  }

  const resolveUrl = `https://ckdatabasews.icloud.com${database}/public/records/resolve?${params}`;
  const resolved = await post(resolveUrl, 'text/plain', { shortGUIDs: [{ value: guid }] });
  const { zoneID, anonymousPublicAccess } = resolved.results?.[0] ?? {};
  if (!zoneID || !anonymousPublicAccess?.token || !anonymousPublicAccess.databasePartition) {
    throw new Error('iCloud did not grant public access to the shared album');
  }
  params.set('publicAccessAuthToken', anonymousPublicAccess.token);
  params.set('clientId', randomUUID());
  const partition = anonymousPublicAccess.databasePartition.replace(/\/$/, '');
  const queryUrl = `${partition}${database}/shared/records/query?${params}`;
  async function query(body) {
    const result = await post(queryUrl, 'text/plain;charset=UTF-8', { zoneID, ...body });
    if (!Array.isArray(result.records)) throw new Error('Missing iCloud query records');
    return result.records;
  }

  const counts = await query({ query: {
    recordType: 'HyperionIndexCountLookup',
    filterBy: [{ fieldName: 'indexCountID', comparator: 'IN',
      fieldValue: { type: 'STRING_LIST', value: ['CPLAssetByAddedDate'] } }],
  } });
  const fields = counts.find(r => r.recordType === 'IndexCountResult')?.fields;
  const count = fields?.count?.value ?? fields?.itemCount?.value;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid iCloud album count');

  const records = [];
  for (let rank = 0; rank < count; rank += 30) {
    const page = await query({
      resultsLimit: 2 * Math.min(30, count - rank),
      query: { recordType: 'CPLAssetAndMasterByAddedDate', filterBy: [
        { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: 'ASCENDING' } },
        { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { type: 'INT64', value: rank } },
      ] },
    });
    records.push(...page);
  }
  const photos = photosFromRecords(records);
  for (let i = photos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [photos[i], photos[j]] = [photos[j], photos[i]];
  }
  return photos;
}

function registerSharedAlbumRoutes(app, fetchPhotos, now = Date.now) {
  const minute = 60_000;
  let album;
  let inFlight;

  async function refresh() {
    const photos = await fetchPhotos();
    const fetchedAt = now();
    const links = new Map();
    let refreshAt = fetchedAt + 60 * minute;
    for (const { id, url } of photos) {
      const expiry = new URL(url).searchParams.get('e');
      let expiresAt = Infinity;
      let linkRefreshAt = fetchedAt + 10 * minute;
      if (expiry && Number.isFinite(Number(expiry))) {
        expiresAt = Number(expiry) * 1000;
        linkRefreshAt = expiresAt - 2 * minute;
        refreshAt = Math.min(refreshAt, linkRefreshAt);
      }
      links.set(id, { url, expiresAt, refreshAt: linkRefreshAt });
    }
    album = { photos, links, refreshAt: Math.max(refreshAt, fetchedAt + minute) };
    return album;
  }

  function getAlbum(id) {
    const time = now();
    if (album && album.refreshAt > time) {
      if (id === undefined || album.links.get(id)?.refreshAt > time) return album;
    }
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  app.get('/api/photos', async (req, res) => {
    try {
      const { photos } = await getAlbum();
      const matching = filterPhotosByOrientation(photos, req.query.orientation);
      // Both displays interpolate these paths into single-quoted CSS url() values.
      res.json(matching.map(({ id }) => '/api/photos/img/' + encodeURIComponent(id).replaceAll("'", '%27')));
    } catch {
      res.set('Cache-Control', 'no-store').status(502).json({ error: 'Unable to load photo album' });
    }
  });

  app.get('/api/photos/img/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { id } = req.params;
      const { links } = await getAlbum(id);
      const link = links.get(id);
      if (!link) return res.status(404).send('Photo not found');
      if (link.expiresAt <= now()) return res.status(502).send('Photo link expired');
      res.redirect(302, link.url);
    } catch {
      res.status(502).send('Unable to load photo album');
    }
  });
}

if (config?.icloudAlbumUrl) {
  registerSharedAlbumRoutes(app, () => fetchSharedAlbumPhotos(config.icloudAlbumUrl));
} else {
  app.get('/api/photos', async (req, res) => {
    try {
      let photos = getCached('photos');
      if (!photos) {
        photos = await fetchICloudPhotos(config.icloudAlbumToken);
        setCache('photos', photos);
      }
      res.json(photos);
    } catch (err) {
      console.error('Photo error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

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

// Baby-cam overlay config (kiosk only). Returns an empty list if `config.babycam`
// is absent → the overlay stays dark and the FAB hidden. No secrets: go2rtc is
// localhost-only on the Pi, so the client only needs the port + stream ids.
app.get('/api/cameras', (req, res) => {
  const bc = config.babycam;
  if (!bc || !Array.isArray(bc.cameras) || bc.cameras.length === 0) return res.json({ cameras: [] });
  res.json({
    port: bc.port || 1984,
    autoCloseHours: bc.autoCloseHours || 2,
    cameras: bc.cameras.map(c => ({ id: c.id, label: c.label })),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`\n🖼️  Family display running → http://localhost:${config.port}\n`);
    if (config.calendars.length === 0) {
      console.log('ℹ️  No calendars configured. Edit config.js to add your iCal feeds.\n');
    }
  });
}

module.exports = { parseAlbumGuid, photosFromRecords, filterPhotosByOrientation, fetchSharedAlbumPhotos, registerSharedAlbumRoutes };
