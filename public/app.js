// ── Config ────────────────────────────────────────────────────────────────────
const PHOTO_INTERVAL   = 30_000;
const WEATHER_REFRESH  = 15 * 60_000;
const CALENDAR_REFRESH =  5 * 60_000;
const CLOCK_TICK       = 1_000;

// ── Shared state ──────────────────────────────────────────────────────────────
let weatherData        = null;   // cached for weather modal
let calendarAllEvents  = [];     // 90-day cache for month modal
let calViewDate        = null;   // first-of-month being shown in calendar modal
let calSelectedKey     = null;   // currently selected day key

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  const d = new Date(dateKey + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  let h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = String(now.getMinutes()).padStart(2, '0');
  document.getElementById('time').textContent = `${h}:${m}`;
  document.getElementById('ampm').textContent = ampm;

  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('dateDay').textContent = days[now.getDay()];

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

let photos = [], photoIndex = 0;
let activeBg = bg1, hiddenBg = bg2;

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
  const total = Math.min(photos.length, 12);
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'photo-dot' + (i === photoIndex % total ? ' active' : '');
    counter.appendChild(dot);
  }
}
async function showPhoto(index) {
  if (photos.length === 0) return;
  const loaded = await preloadImage(photos[index % photos.length]);
  if (!loaded) { advancePhoto(); return; }
  hiddenBg.style.backgroundImage = `url('${loaded}')`;
  hiddenBg.style.opacity = '1';
  activeBg.style.opacity = '0';
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
      photos = urls; photoIndex = 0; showPhoto(0);
    }
  } catch (err) { console.warn('Photos unavailable:', err.message); }
}
loadPhotos();
setInterval(advancePhoto, PHOTO_INTERVAL);

// ── Weather ───────────────────────────────────────────────────────────────────
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    weatherData = await res.json();

    document.getElementById('weatherIcon').textContent  = weatherData.icon ?? '🌡️';
    document.getElementById('weatherTemp').textContent  = `${weatherData.temp}°`;
    document.getElementById('weatherLabel').textContent = `${weatherData.label} · feels ${weatherData.feels}°`;

    const forecastEl = document.getElementById('weatherForecast');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    forecastEl.innerHTML = weatherData.daily.slice(1, 4).map(day => {
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

// ── Calendar strip ────────────────────────────────────────────────────────────
async function loadCalendar() {
  const container = document.getElementById('eventsInner');
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { events, unconfigured } = await res.json();
    container.innerHTML = '';

    if (unconfigured) {
      container.innerHTML = `<div class="cal-setup-hint">
        <h3>Add your calendars</h3>
        <p>Open <code>config.js</code> and add your iCal feed URLs to the
        <code>calendars</code> array.</p></div>`;
      return;
    }
    if (events.length === 0) {
      container.innerHTML = `<div class="day-col">
        <div class="day-label today">Upcoming</div>
        <div class="no-events">Nothing scheduled — enjoy your day!</div>
      </div>`;
      return;
    }

    const byDay = new Map();
    for (const ev of events) {
      const key = dayKey(ev.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }
    const todayKey = localDateKey(new Date());

    for (const [dateKey, dayEvents] of byDay) {
      const col = document.createElement('div');
      col.className = 'day-col';

      const label = document.createElement('div');
      label.className = 'day-label' + (dateKey === todayKey ? ' today' : '');
      label.textContent = dayHeading(dateKey);
      col.appendChild(label);

      for (const ev of dayEvents) {
        const item   = document.createElement('div');
        item.className = 'event-item';

        const accent = document.createElement('div');
        accent.className = 'event-accent';
        accent.style.background = ev.color;

        const body    = document.createElement('div');
        body.className = 'event-body';

        const timeEl  = document.createElement('div');
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
    container.innerHTML = `<div class="day-col">
      <div class="day-label">Calendar</div>
      <div class="no-events">Could not load events</div>
    </div>`;
  }
}
loadCalendar();
setInterval(loadCalendar, CALENDAR_REFRESH);

// ── Weather modal ─────────────────────────────────────────────────────────────
const weatherBackdrop = document.getElementById('weatherBackdrop');

function openWeatherModal() {
  if (!weatherData) return;

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayKey = localDateKey(new Date());

  document.getElementById('weatherModalTitle').textContent =
    `Weekly Forecast · ${weatherData.city}`;

  document.getElementById('forecastRows').innerHTML = weatherData.daily.map(day => {
    const d       = new Date(day.date + 'T12:00:00');
    const isToday = day.date === todayKey;
    const precip  = day.precip != null ? `💧 ${day.precip}%` : '';
    return `<div class="forecast-row${isToday ? ' is-today' : ''}">
      <div class="fr-day">${isToday ? 'Today' : dayNames[d.getDay()]}</div>
      <div class="fr-icon">${day.icon}</div>
      <div class="fr-label">${day.label}</div>
      <div class="fr-precip">${precip}</div>
      <div class="fr-temps">
        <div class="fr-hi">${day.high}°</div>
        <div class="fr-lo">${day.low}°</div>
      </div>
    </div>`;
  }).join('');

  weatherBackdrop.hidden = false;
}

function closeWeatherModal() { weatherBackdrop.hidden = true; }

document.getElementById('weatherBlock').addEventListener('click', openWeatherModal);
document.getElementById('weatherClose').addEventListener('click', e => { e.stopPropagation(); closeWeatherModal(); });
weatherBackdrop.addEventListener('click', e => { if (e.target === weatherBackdrop) closeWeatherModal(); });

// ── Calendar month modal ──────────────────────────────────────────────────────
const calendarBackdrop = document.getElementById('calendarBackdrop');

async function openCalendarModal() {
  calendarBackdrop.hidden = false;
  calViewDate = new Date();
  calViewDate.setDate(1);

  // Fetch 90 days if we don't have them yet (cached after first open)
  if (calendarAllEvents.length === 0) {
    try {
      const res = await fetch('/api/calendar?days=90');
      if (res.ok) {
        const data = await res.json();
        calendarAllEvents = data.events || [];
      }
    } catch (err) { console.warn('Calendar modal fetch failed:', err.message); }
  }

  renderCalendarMonth();
}

function closeCalendarModal() {
  calendarBackdrop.hidden = true;
  calSelectedKey = null;
}

function renderCalendarMonth() {
  const year  = calViewDate.getFullYear();
  const month = calViewDate.getMonth();

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  document.getElementById('calMonthTitle').textContent = `${MONTH_NAMES[month]} ${year}`;

  const firstDow   = new Date(year, month, 1).getDay();   // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey   = localDateKey(new Date());

  // Build event map for this month's grid
  const eventMap = {};
  for (const ev of calendarAllEvents) {
    const key = dayKey(ev.start);
    if (!eventMap[key]) eventMap[key] = [];
    eventMap[key].push(ev);
  }

  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement('div');
    const dayNum = i - firstDow + 1;

    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.className = 'cal-cell empty';
      grid.appendChild(cell);
      continue;
    }

    const dateKey   = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    const isToday   = dateKey === todayKey;
    const isSelected = dateKey === calSelectedKey;
    const dayEvents = eventMap[dateKey] || [];

    cell.className = 'cal-cell'
      + (isToday    ? ' is-today'  : '')
      + (isSelected ? ' selected'  : '');

    const numEl = document.createElement('div');
    numEl.className = 'cal-num';
    numEl.textContent = dayNum;
    cell.appendChild(numEl);

    if (dayEvents.length > 0) {
      const dotsEl = document.createElement('div');
      dotsEl.className = 'cal-dots';
      const shown = dayEvents.slice(0, 4);
      for (const ev of shown) {
        const dot = document.createElement('div');
        dot.className = 'cal-dot';
        dot.style.background = ev.color;
        dotsEl.appendChild(dot);
      }
      if (dayEvents.length > 4) {
        const more = document.createElement('span');
        more.className = 'cal-more';
        more.textContent = `+${dayEvents.length - 4}`;
        dotsEl.appendChild(more);
      }
      cell.appendChild(dotsEl);
    }

    cell.addEventListener('click', () => selectCalDay(dateKey, dayEvents, cell));
    grid.appendChild(cell);
  }

  // Re-render day panel if something was selected
  if (calSelectedKey) {
    const ev = eventMap[calSelectedKey] || [];
    renderCalDayPanel(calSelectedKey, ev);
  } else {
    document.getElementById('calDayPanel').innerHTML = '';
  }
}

function selectCalDay(dateKey, events, cell) {
  document.querySelectorAll('.cal-cell.selected').forEach(c => c.classList.remove('selected'));
  cell.classList.add('selected');
  calSelectedKey = dateKey;
  renderCalDayPanel(dateKey, events);
}

function renderCalDayPanel(dateKey, events) {
  const panel = document.getElementById('calDayPanel');
  const [y, mo, d] = dateKey.split('-').map(Number);
  const date  = new Date(y, mo - 1, d);
  const title = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  panel.innerHTML = `<div class="cal-day-title">${title}</div>`;

  if (events.length === 0) {
    panel.innerHTML += '<div class="cal-empty-day">Nothing scheduled</div>';
    return;
  }
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'cal-day-event';

    const dot = document.createElement('div');
    dot.className = 'cal-day-dot';
    dot.style.background = ev.color;

    const timeEl = document.createElement('div');
    timeEl.className = 'cal-day-time';
    timeEl.textContent = fmtTime(ev.start, ev.allDay);

    const titleEl = document.createElement('div');
    titleEl.className = 'cal-day-event-title';
    titleEl.textContent = ev.title;

    row.append(dot, timeEl, titleEl);
    panel.appendChild(row);
  }
}

// Month navigation
document.getElementById('monthPrev').addEventListener('click', () => {
  calViewDate.setMonth(calViewDate.getMonth() - 1);
  calSelectedKey = null;
  renderCalendarMonth();
});
document.getElementById('monthNext').addEventListener('click', () => {
  calViewDate.setMonth(calViewDate.getMonth() + 1);
  calSelectedKey = null;
  renderCalendarMonth();
});

document.getElementById('fabCalendar').addEventListener('click', openCalendarModal);
document.getElementById('calendarClose').addEventListener('click', e => { e.stopPropagation(); closeCalendarModal(); });
calendarBackdrop.addEventListener('click', e => { if (e.target === calendarBackdrop) closeCalendarModal(); });

// Close modals on Escape (keyboard / remote)
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeWeatherModal(); closeCalendarModal(); }
});
