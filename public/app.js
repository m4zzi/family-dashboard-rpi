// ── Config ────────────────────────────────────────────────────────────────────
const PHOTO_INTERVAL   = 30_000;
const WEATHER_REFRESH  = 15 * 60_000;
const CALENDAR_REFRESH =  5 * 60_000;
const CLOCK_TICK       = 1_000;

// ── Shared state ──────────────────────────────────────────────────────────────
let weatherData        = null;
let calendarByDay      = new Map();
let calendarFetchedAt  = null;
let calendarUnavailable = false;
let calViewDate        = null;
let calSelectedKey     = null;
let expandedForecastDate = null;  // which day row has its hourly strip open
let birthdaysByDate      = {};   // keyed by "MM-DD" for calendar modal lookup

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
function fmtHour(h) {
  if (h === 0)  return '12am';
  if (h < 12)   return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}
function groupEventsByDay(events, firstDay, windowEnd, fallbackDays = 14) {
  // Older calendar responses omit windowEnd until the server has restarted.
  const today = new Date();
  const until = windowEnd ? Date.parse(windowEnd) : today.setDate(today.getDate() + fallbackDays);
  const byDay = new Map();
  const first = new Date(firstDay);
  first.setHours(0, 0, 0, 0);
  for (const ev of events) {
    const start = new Date(ev.start);
    const end = ev.end ? new Date(ev.end) : start;
    // End is exclusive at midnight. A zero-duration event still occupies its start day.
    const last = Math.min(until, end > start ? end.getTime() - 1 : start.getTime());
    const day = new Date(Math.max(first, start));
    day.setHours(0, 0, 0, 0);
    for (; day <= last; day.setDate(day.getDate() + 1)) {
      const key = localDateKey(day);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }
  }
  return byDay;
}
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function dayHeading(dateKey) {
  const date = new Date();
  const today = localDateKey(date);
  date.setDate(date.getDate() + 1);
  const tomorrow = localDateKey(date);
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
let photos = [], photoIndex = -1, activeBg = bg1, hiddenBg = bg2;
let photoInFlight = false;

function preloadImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    const timeout = setTimeout(() => {
      finish(null);
      img.removeAttribute('src');
    }, 20_000);
    function finish(loaded) {
      clearTimeout(timeout);
      img.onload = img.onerror = null;
      resolve(loaded);
    }
    img.onload  = () => finish(url);
    img.onerror = () => finish(null);
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
async function advancePhoto() {
  if (photoInFlight || !photos.length) return;
  photoInFlight = true;
  const list = photos;
  try {
    for (let attempt = 0; attempt < list.length && list === photos; attempt++) {
      photoIndex = (photoIndex + 1) % list.length;
      const loaded = await preloadImage(list[photoIndex]);
      if (list !== photos) break;
      if (loaded) {
        hiddenBg.style.backgroundImage = `url('${loaded}')`;
        hiddenBg.style.opacity = '1';
        activeBg.style.opacity = '0';
        [activeBg, hiddenBg] = [hiddenBg, activeBg];
        updateDots();
        return;
      }
      if (attempt + 1 < list.length) await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  } finally {
    photoInFlight = false;
    if (list !== photos) advancePhoto();
  }
}
async function loadPhotos() {
  let refreshIn = 60_000;
  try {
    const res = await fetch('/api/photos?orientation=landscape');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const urls = await res.json();
    if (Array.isArray(urls) && urls.length > 0) {
      photos = urls;
      photoIndex = -1;
      advancePhoto();
      refreshIn = 60 * 60_000;
    }
  } catch (err) { console.warn('Photos unavailable:', err.message); }
  setTimeout(loadPhotos, refreshIn);
}
loadPhotos();
setInterval(advancePhoto, PHOTO_INTERVAL);

// ── Weather ───────────────────────────────────────────────────────────────────
let weatherExpiryTimer;
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('weatherIcon').textContent  = data.icon ?? '🌡️';
    document.getElementById('weatherTemp').textContent  = `${data.temp}°`;
    document.getElementById('weatherLabel').textContent = `${data.label} · feels ${data.feels}°`;

    const forecastEl = document.getElementById('weatherForecast');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayKey = localDateKey(new Date());
    forecastEl.innerHTML = data.daily.filter(day => day.date > todayKey).slice(0, 3).map(day => {
      const d = new Date(day.date + 'T12:00:00');
      return `<div class="forecast-day">
        <div class="forecast-day-name">${dayNames[d.getDay()]}</div>
        <div class="forecast-day-icon">${day.icon}</div>
        <div class="forecast-day-hi">${day.high}°</div>
        <div class="forecast-day-lo">${day.low}°</div>
      </div>`;
    }).join('');
    weatherData = data;
    document.getElementById('weatherBlock').style.display = '';
    clearTimeout(weatherExpiryTimer);
    weatherExpiryTimer = setTimeout(() => {
      document.getElementById('weatherBlock').style.display = 'none';
    }, 2 * 60 * 60_000);
  } catch (err) {
    console.warn('Weather unavailable:', err.message);
    if (!weatherData) document.getElementById('weatherBlock').style.display = 'none';
  }
}
loadWeather();
setInterval(loadWeather, WEATHER_REFRESH);

// ── Birthdays ────────────────────────────────────────────────────────────────
const birthdayBanner = document.getElementById('birthdayBanner');
async function loadBirthdays() {
  try {
    const res = await fetch('/api/birthdays');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const birthdays = await res.json();
    // Build lookup for calendar modal
    birthdaysByDate = {};
    for (const b of birthdays) {
      const key = `${String(b.month).padStart(2,'0')}-${String(b.day).padStart(2,'0')}`;
      if (!birthdaysByDate[key]) birthdaysByDate[key] = [];
      birthdaysByDate[key].push(b.name);
    }

    const upcoming = birthdays.filter(b => b.daysUntil <= 14);
    if (upcoming.length === 0) { birthdayBanner.hidden = true; return; }

    birthdayBanner.hidden = false;
    birthdayBanner.innerHTML = '';
    for (const b of upcoming) {
      const span = document.createElement('span');
      if (b.daysUntil === 0) {
        span.className = 'bday-item bday-today';
        span.textContent = `\u{1F382} ${b.name}'s birthday!`;
      } else if (b.daysUntil === 1) {
        span.className = 'bday-item';
        span.textContent = `\u{1F381} ${b.name} tomorrow`;
      } else {
        span.className = 'bday-item';
        span.textContent = `\u{1F381} ${b.name} in ${b.daysUntil}d`;
      }
      birthdayBanner.appendChild(span);
    }
  } catch (err) {
    console.warn('Birthdays unavailable:', err.message);
    birthdayBanner.hidden = true;
  }
}
loadBirthdays();
setInterval(loadBirthdays, 60 * 60_000); // refresh hourly

// ── Calendar strip ────────────────────────────────────────────────────────────
async function loadCalendar() {
  const container = document.getElementById('eventsInner');
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { events, unconfigured, error, windowEnd } = await res.json();
    container.innerHTML = '';

    if (unconfigured) {
      container.innerHTML = `<div class="cal-setup-hint">
        <h3>Add your calendars</h3>
        <p>Open <code>config.js</code> and add your iCal feed URLs.</p></div>`;
      return;
    }
    const byDay = groupEventsByDay(events, new Date(), windowEnd);
    if (byDay.size === 0) {
      container.innerHTML = `<div class="day-col">
        <div class="day-label today">Upcoming</div>
        <div class="no-events">${error ? 'Calendar unavailable' : 'Nothing scheduled — enjoy your day!'}</div>
      </div>`;
      return;
    }

    const todayKey = localDateKey(new Date());

    for (const dateKey of [...byDay.keys()].sort()) {
      const dayEvents = byDay.get(dateKey);
      const col = document.createElement('div');
      col.className = 'day-col';

      const label = document.createElement('div');
      label.className = 'day-label' + (dateKey === todayKey ? ' today' : '');
      label.textContent = dayHeading(dateKey);
      col.appendChild(label);

      for (const ev of dayEvents) {
        const item    = document.createElement('div');
        item.className = 'event-item';
        const accent  = document.createElement('div');
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
      <div class="no-events">Calendar unavailable</div>
    </div>`;
  }
}
loadCalendar();
setInterval(loadCalendar, CALENDAR_REFRESH);

// ── Hourly strip builder ──────────────────────────────────────────────────────
function buildHourlyStrip(date) {
  const hours = weatherData?.hourlyByDay?.[date];
  if (!hours || hours.length === 0) return null;

  const nowHour   = new Date().getHours();
  const todayKey  = localDateKey(new Date());
  const isToday   = date === todayKey;

  const strip = document.createElement('div');
  strip.className = 'hourly-strip';

  for (const h of hours) {
    const card = document.createElement('div');
    const isPast = isToday && h.hour < nowHour;
    const isNow  = isToday && h.hour === nowHour;
    card.className = 'hour-card'
      + (isNow  ? ' is-now'  : '')
      + (isPast ? ' is-past' : '');

    const precip = h.precip > 10 ? `💧${h.precip}%` : '';
    card.innerHTML = `
      <div class="hour-label">${fmtHour(h.hour)}</div>
      <div class="hour-icon">${h.icon}</div>
      <div class="hour-temp">${h.temp}°</div>
      <div class="hour-precip">${precip}</div>`;
    strip.appendChild(card);

    // Scroll current hour into centre of the strip — only scroll the strip
    // horizontally; never use scrollIntoView which also scrolls parent modal
    if (isNow) requestAnimationFrame(() => {
      strip.scrollLeft = card.offsetLeft - strip.offsetWidth / 2 + card.offsetWidth / 2;
    });
  }

  attachDragScroll(strip, { axis: 'x', isolated: true });  // isolated: stops propagation to modal's vertical handler
  return strip;
}

// ── Weather modal ─────────────────────────────────────────────────────────────
const weatherBackdrop = document.getElementById('weatherBackdrop');
const DAY_NAMES_FULL  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function buildForecastRow(day, index, isExpanded) {
  const d       = new Date(day.date + 'T12:00:00');
  const isToday = day.date === localDateKey(new Date());
  const label   = isToday ? 'Today' : DAY_NAMES_FULL[d.getDay()];
  const precip  = day.precip > 0 ? `💧 ${day.precip}% rain` : '';

  const row = document.createElement('div');
  row.className = 'forecast-row' + (isToday ? ' is-today' : '');
  row.style.animationDelay = `${index * 0.055}s`;
  row.dataset.date = day.date;

  row.innerHTML = `
    <div class="fr-main">
      <div class="fr-day">${label}</div>
      <div class="fr-icon">${day.icon}</div>
      <div class="fr-meta">
        <div class="fr-label">${day.label}</div>
        ${precip ? `<div class="fr-precip">${precip}</div>` : ''}
      </div>
      <div class="fr-temps">
        <div class="fr-hi">${day.high}°</div>
        <div class="fr-lo">${day.low}°</div>
      </div>
    </div>`;

  // Add hourly strip if this day is expanded
  if (isExpanded) {
    const strip = buildHourlyStrip(day.date);
    if (strip) row.appendChild(strip);
  }

  // Toggle hourly on tap
  row.addEventListener('click', () => {
    if (expandedForecastDate === day.date) {
      expandedForecastDate = null;
    } else {
      expandedForecastDate = day.date;
    }
    renderWeatherModal();
  });

  return row;
}

function renderWeatherModal() {
  document.getElementById('weatherModalTitle').textContent =
    `Weekly Forecast · ${weatherData.city}`;

  const container = document.getElementById('forecastRows');
  container.innerHTML = '';

  weatherData.daily.forEach((day, i) => {
    const isExpanded = expandedForecastDate === day.date;
    container.appendChild(buildForecastRow(day, i, isExpanded));
  });
}

function openWeatherModal() {
  if (!weatherData) return;
  expandedForecastDate = localDateKey(new Date());
  renderWeatherModal();
  weatherBackdrop.hidden = false;
}
function closeWeatherModal() {
  weatherBackdrop.hidden = true;
}

document.getElementById('weatherBlock').addEventListener('click', openWeatherModal);
document.getElementById('weatherClose').addEventListener('click', e => { e.stopPropagation(); closeWeatherModal(); });
weatherBackdrop.addEventListener('click', e => { if (e.target === weatherBackdrop) closeWeatherModal(); });

// ── Calendar month modal ──────────────────────────────────────────────────────
const calendarBackdrop = document.getElementById('calendarBackdrop');

async function openCalendarModal() {
  calendarBackdrop.hidden = false;
  const today = new Date();
  const windowStart = new Date(today.getFullYear(), today.getMonth(), 1);
  calViewDate = new Date(windowStart);

  if (calendarFetchedAt === null || Date.now() - calendarFetchedAt >= CALENDAR_REFRESH) {
    try {
      const res = await fetch(`/api/calendar?days=90&pastDays=${today.getDate() - 1}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { events, error, windowEnd } = await res.json();
      calendarByDay = groupEventsByDay(events, windowStart, windowEnd, 90);
      calendarUnavailable = Boolean(error && !events.length);
      calendarFetchedAt = calendarUnavailable ? null : Date.now();
    } catch (err) {
      console.warn('Calendar modal fetch failed:', err.message);
      calendarByDay.clear();
      calendarUnavailable = true;
      calendarFetchedAt = null;
    }
  }
  renderCalendarMonth('none');
}
function closeCalendarModal() {
  calendarBackdrop.hidden = true;
  calSelectedKey = null;
}

function renderCalendarMonth(direction) {
  const year  = calViewDate.getFullYear();
  const month = calViewDate.getMonth();
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('calMonthTitle').textContent = `${MONTHS[month]} ${year}`;

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey    = localDateKey(new Date());

  const grid = document.getElementById('calGrid');
  // Apply directional slide class
  grid.className = 'cal-grid'
    + (direction === 'forward'  ? ' slide-forward'  : '')
    + (direction === 'backward' ? ' slide-backward' : '');
  grid.innerHTML = '';

  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const cell   = document.createElement('div');
    const dayNum = i - firstDow + 1;

    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.className = 'cal-cell empty';
      grid.appendChild(cell);
      continue;
    }

    const dateKey   = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    const isToday   = dateKey === todayKey;
    const isSelected = dateKey === calSelectedKey;
    const dayEvents  = calendarByDay.get(dateKey) || [];

    cell.className = 'cal-cell'
      + (isToday    ? ' is-today'  : '')
      + (isSelected ? ' selected'  : '');

    const numEl = document.createElement('div');
    numEl.className = 'cal-num';
    numEl.textContent = dayNum;
    cell.appendChild(numEl);

    // Birthday dot for this cell
    const cellBdayKey = `${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    const cellBdays = birthdaysByDate[cellBdayKey];

    if (dayEvents.length > 0 || cellBdays) {
      const dotsEl = document.createElement('div');
      dotsEl.className = 'cal-dots';
      if (cellBdays) {
        const dot = document.createElement('div');
        dot.className = 'cal-dot';
        dot.style.background = 'var(--accent)';
        dotsEl.appendChild(dot);
      }
      dayEvents.slice(0, 4).forEach(ev => {
        const dot = document.createElement('div');
        dot.className = 'cal-dot';
        dot.style.background = ev.color;
        dotsEl.appendChild(dot);
      });
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

  if (calSelectedKey) {
    renderCalDayPanel(calSelectedKey, calendarByDay.get(calSelectedKey) || []);
  } else {
    document.getElementById('calDayPanel').innerHTML = calendarUnavailable
      ? '<div class="cal-empty-day">Calendar unavailable</div>' : '';
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
  const title = new Date(y, mo - 1, d)
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  panel.innerHTML = `<div class="cal-day-title">${title}</div>`;

  // Show birthdays for this date
  const bdayKey = `${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const bdays = birthdaysByDate[bdayKey];
  if (bdays) {
    for (const name of bdays) {
      const row = document.createElement('div');
      row.className = 'cal-day-event cal-day-birthday';
      const dot = document.createElement('div');
      dot.className = 'cal-day-dot';
      dot.style.background = 'var(--accent)';
      const timeEl = document.createElement('div');
      timeEl.className = 'cal-day-time';
      timeEl.textContent = '\u{1F382}';
      const titleEl = document.createElement('div');
      titleEl.className = 'cal-day-event-title';
      titleEl.textContent = `${name}'s birthday`;
      titleEl.style.color = 'var(--accent)';
      row.append(dot, timeEl, titleEl);
      panel.appendChild(row);
    }
  }

  if (events.length === 0 && (calendarUnavailable || !bdays)) {
    panel.innerHTML += `<div class="cal-empty-day">${calendarUnavailable ? 'Calendar unavailable' : 'Nothing scheduled'}</div>`;
    return;
  }
  for (const ev of events) {
    const row     = document.createElement('div');
    row.className = 'cal-day-event';
    const dot     = document.createElement('div');
    dot.className = 'cal-day-dot';
    dot.style.background = ev.color;
    const timeEl  = document.createElement('div');
    timeEl.className = 'cal-day-time';
    timeEl.textContent = fmtTime(ev.start, ev.allDay);
    const titleEl = document.createElement('div');
    titleEl.className = 'cal-day-event-title';
    titleEl.textContent = ev.title;
    row.append(dot, timeEl, titleEl);
    panel.appendChild(row);
  }
}

// Month navigation with directional slide
document.getElementById('monthPrev').addEventListener('click', () => {
  calViewDate.setMonth(calViewDate.getMonth() - 1);
  calSelectedKey = null;
  renderCalendarMonth('backward');
});
document.getElementById('monthNext').addEventListener('click', () => {
  calViewDate.setMonth(calViewDate.getMonth() + 1);
  calSelectedKey = null;
  renderCalendarMonth('forward');
});

document.getElementById('fabCalendar').addEventListener('click', openCalendarModal);
document.getElementById('calendarClose').addEventListener('click', e => { e.stopPropagation(); closeCalendarModal(); });
calendarBackdrop.addEventListener('click', e => { if (e.target === calendarBackdrop) closeCalendarModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeWeatherModal(); closeCalendarModal(); }
});

// ── Drag-scroll helper ────────────────────────────────────────────────────────
// CSS native scroll is unreliable on Chromium/Linux kiosk — Pointer Events API
// handles mouse drag and touch in one path, no text-selection fights.
//
// axis:'x'  — setPointerCapture so drag works even if pointer leaves element.
//             Pass isolated:true to stop pointerdown bubbling (prevents a
//             parent vertical handler from stealing the pointer capture).
// axis:'y'  — uses document-level move/up listeners instead of setPointerCapture
//             so child click handlers (e.g. forecast rows) still fire normally.
function attachDragScroll(el, { axis = 'x', snapChildSelector = null, isolated = false } = {}) {
  const horiz = axis === 'x';
  let startPos    = null;
  let startScroll = 0;
  let moved       = false;

  el.addEventListener('pointerdown', e => {
    if (isolated) e.stopPropagation();   // prevent parent handler stealing capture
    startPos    = horiz ? e.clientX : e.clientY;
    startScroll = horiz ? el.scrollLeft : el.scrollTop;
    moved       = false;
    if (horiz) {
      el.setPointerCapture(e.pointerId);
      el.style.scrollSnapType = 'none';
    }
  }, { passive: true });

  // Vertical uses document so pointer can drift outside modal without losing drag
  const moveTarget = horiz ? el : document;
  const upTarget   = horiz ? el : document;

  moveTarget.addEventListener('pointermove', e => {
    if (startPos === null) return;
    const delta = startPos - (horiz ? e.clientX : e.clientY);
    if (Math.abs(delta) > 6) moved = true;
    if (horiz) el.scrollLeft = startScroll + delta;
    else       el.scrollTop  = startScroll + delta;
  }, { passive: true });

  function onEnd() {
    if (startPos === null) return;
    if (horiz) {
      el.style.scrollSnapType = '';
      if (moved && snapChildSelector) {
        const child = el.querySelector(snapChildSelector);
        const gap   = child ? parseFloat(getComputedStyle(el).gap) || 0 : 0;
        const colW  = child ? child.offsetWidth + gap : 1;
        el.scrollTo({ left: Math.round(el.scrollLeft / colW) * colW, behavior: 'smooth' });
      }
      // Absorb the ghost click that fires after a horizontal drag on some platforms
      if (moved) el.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
    }
    startPos = null;
  }

  upTarget.addEventListener('pointerup',     onEnd);
  upTarget.addEventListener('pointercancel', onEnd);
}

// Events strip — horizontal, snap to day columns
attachDragScroll(document.getElementById('eventsInner'), { axis: 'x', snapChildSelector: '.day-col' });

// Modals — vertical free-scroll (document listeners, no capture = child clicks still work)
attachDragScroll(document.getElementById('weatherModal'),  { axis: 'y' });
attachDragScroll(document.getElementById('calendarModal'), { axis: 'y' });
