// ── Config (mirrored client-side for UI) ─────────────────────────────────────
const PHOTO_INTERVAL = 30_000; // ms — should match server config.js
const WEATHER_REFRESH = 15 * 60_000;
const CALENDAR_REFRESH = 5 * 60_000;
const CLOCK_TICK = 1_000;

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();

  // Time (12-hour, no leading zero)
  let h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('time').textContent = `${h}:${m}`;
  document.getElementById('ampm').textContent = ampm;

  // Day name
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('dateDay').textContent = days[now.getDay()];

  // Full date
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('dateFull').textContent =
    `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}
setInterval(updateClock, CLOCK_TICK);
updateClock();

// ── Photo slideshow ───────────────────────────────────────────────────────────
const bg1 = document.getElementById('photoBg1');
const bg2 = document.getElementById('photoBg2');
const counter = document.getElementById('photoCounter');

let photos = [];
let photoIndex = 0;
let activeBg = bg1; // currently visible layer
let hiddenBg = bg2; // being preloaded / fading in

function preloadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(url);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function updateDots() {
  counter.innerHTML = '';
  if (photos.length <= 1) return;
  const maxDots = 12;
  const total = Math.min(photos.length, maxDots);
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'photo-dot' + (i === photoIndex % total ? ' active' : '');
    counter.appendChild(dot);
  }
}

async function showPhoto(index) {
  if (photos.length === 0) return;
  const url = photos[index % photos.length];
  const loaded = await preloadImage(url);
  if (!loaded) { advancePhoto(); return; } // skip broken images

  hiddenBg.style.backgroundImage = `url('${loaded}')`;
  hiddenBg.style.opacity = '1';
  activeBg.style.opacity = '0';

  // Swap references
  [activeBg, hiddenBg] = [hiddenBg, activeBg];
  updateDots();
}

function advancePhoto() {
  photoIndex = (photoIndex + 1) % (photos.length || 1);
  showPhoto(photoIndex);
}

async function loadPhotos() {
  try {
    const res = await fetch('/api/photos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const urls = await res.json();
    if (Array.isArray(urls) && urls.length > 0) {
      photos = urls;
      photoIndex = 0;
      showPhoto(0);
    }
  } catch (err) {
    console.warn('Photos unavailable:', err.message);
  }
}

// Initial load + rotate
loadPhotos();
setInterval(advancePhoto, PHOTO_INTERVAL);

// ── Weather ───────────────────────────────────────────────────────────────────
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const w = await res.json();

    document.getElementById('weatherIcon').textContent  = w.icon ?? '🌡️';
    document.getElementById('weatherTemp').textContent  = `${w.temp}°`;
    document.getElementById('weatherLabel').textContent = `${w.label} · feels ${w.feels}°`;

    // 3-day forecast (daily[0] = today, so show 1–3)
    const forecastEl = document.getElementById('weatherForecast');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    forecastEl.innerHTML = w.daily.slice(1, 4).map(day => {
      const d = new Date(day.date + 'T12:00:00');
      return `<div class="forecast-day">
        <div class="forecast-day-name">${dayNames[d.getDay()]}</div>
        <div class="forecast-day-icon">${day.icon}</div>
        <div class="forecast-day-hi">${day.high}°</div>
        <div class="forecast-day-lo">${day.low}°</div>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('Weather unavailable:', err.message);
    document.getElementById('weatherBlock').style.display = 'none';
  }
}

loadWeather();
setInterval(loadWeather, WEATHER_REFRESH);

// ── Calendar ──────────────────────────────────────────────────────────────────
function fmtTime(isoString, allDay) {
  if (allDay) return 'All day';
  const d = new Date(isoString);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return m === '00' ? `${h} ${ampm}` : `${h}:${m} ${ampm}`;
}

function dayKey(isoString) {
  // Returns "YYYY-MM-DD" in local time
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function dayHeading(dateKey) {
  const today    = localDateKey(new Date());
  const tomorrow = localDateKey(new Date(Date.now() + 86_400_000));
  if (dateKey === today)    return 'Today';
  if (dateKey === tomorrow) return 'Tomorrow';

  const d = new Date(dateKey + 'T12:00:00'); // noon to avoid DST edge cases
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

async function loadCalendar() {
  const container = document.getElementById('eventsInner');

  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { events, unconfigured } = await res.json();

    container.innerHTML = '';

    if (unconfigured) {
      container.innerHTML = `
        <div class="cal-setup-hint">
          <h3>Add your calendars</h3>
          <p>Open <code>config.js</code> and add your iCal feed URLs to the
          <code>calendars</code> array. Apple Calendar and Google Calendar both
          support iCal feeds — see the comments in that file for instructions.</p>
        </div>`;
      return;
    }

    if (events.length === 0) {
      container.innerHTML = `
        <div class="day-col">
          <div class="day-label today">Upcoming</div>
          <div class="no-events">Nothing scheduled — enjoy your day!</div>
        </div>`;
      return;
    }

    // Group events by date
    const byDay = new Map();
    for (const ev of events) {
      const key = dayKey(ev.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }

    const todayKey = localDateKey(new Date());

    for (const [dateKey, dayEvents] of byDay) {
      const isToday = dateKey === todayKey;
      const col = document.createElement('div');
      col.className = 'day-col';

      const label = document.createElement('div');
      label.className = 'day-label' + (isToday ? ' today' : '');
      label.textContent = dayHeading(dateKey);
      col.appendChild(label);

      for (const ev of dayEvents) {
        const item = document.createElement('div');
        item.className = 'event-item';

        const accent = document.createElement('div');
        accent.className = 'event-accent';
        accent.style.background = ev.color;

        const body = document.createElement('div');
        body.className = 'event-body';

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time' + (ev.allDay ? ' allday' : '');
        timeEl.textContent = fmtTime(ev.start, ev.allDay);

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = ev.title;

        body.append(timeEl, titleEl);
        item.append(accent, body);
        col.appendChild(item);
      }

      container.appendChild(col);
    }
  } catch (err) {
    console.warn('Calendar unavailable:', err.message);
    container.innerHTML = `
      <div class="day-col">
        <div class="day-label">Calendar</div>
        <div class="no-events">Could not load events</div>
      </div>`;
  }
}

loadCalendar();
setInterval(loadCalendar, CALENDAR_REFRESH);
