// ── Portrait view for Meural static snapshots ───────────────────────────────
// No clock (static image), shows: date, weather, forecast, birthdays, events

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Date ─────────────────────────────────────────────────────────────────────
function updateDate() {
  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  document.getElementById('dateDay').textContent = days[now.getDay()];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  document.getElementById('dateFull').textContent =
    `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}
updateDate();

// ── Photo background ─────────────────────────────────────────────────────────
const bg1 = document.getElementById('photoBg1');
let photos = [];

async function loadPhotos() {
  try {
    const res = await fetch('/api/photos');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const urls = await res.json();
    if (Array.isArray(urls) && urls.length > 0) {
      photos = urls;
      // Pick a random photo for the static snapshot
      const url = photos[Math.floor(Math.random() * photos.length)];
      bg1.style.backgroundImage = `url('${url}')`;
    }
  } catch (err) { console.warn('Photos unavailable:', err.message); }
}
loadPhotos();

// ── Weather ──────────────────────────────────────────────────────────────────
async function loadWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('weatherIcon').textContent = data.icon ?? '🌡️';
    document.getElementById('weatherTemp').textContent = `${data.temp}°`;
    document.getElementById('weatherLabel').textContent = `${data.label} · feels ${data.feels}°`;

    // Forecast strip — show 5 days
    const strip = document.getElementById('forecastStrip');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const todayKey = localDateKey(new Date());

    strip.innerHTML = data.daily.slice(0, 5).map(day => {
      const d = new Date(day.date + 'T12:00:00');
      const isToday = day.date === todayKey;
      const name = isToday ? 'Today' : dayNames[d.getDay()];
      return `<div class="fc-item${isToday ? ' is-today' : ''}">
        <span class="fc-name">${name}</span>
        <span class="fc-icon">${day.icon}</span>
        <span class="fc-temps"><span class="fc-hi">${day.high}°</span><span class="fc-lo">${day.low}°</span></span>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('Weather unavailable:', err.message);
  }
}
loadWeather();

// ── Birthdays ────────────────────────────────────────────────────────────────
const birthdayBanner = document.getElementById('birthdayBanner');
async function loadBirthdays() {
  try {
    const res = await fetch('/api/birthdays');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const birthdays = await res.json();
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

// ── Calendar events ──────────────────────────────────────────────────────────
async function loadCalendar() {
  const container = document.getElementById('eventsPanel');
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { events } = await res.json();
    container.innerHTML = '';

    if (!events || events.length === 0) {
      container.innerHTML = `<div class="day-heading today">Upcoming</div>
        <div class="no-events">Nothing scheduled</div>`;
      return;
    }

    const byDay = new Map();
    for (const ev of events) {
      const key = dayKey(ev.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }
    const todayKey = localDateKey(new Date());

    // Show up to 3 days
    let dayCount = 0;
    for (const [dateKey, dayEvents] of byDay) {
      if (dayCount >= 3) break;

      const heading = document.createElement('div');
      heading.className = 'day-heading' + (dateKey === todayKey ? ' today' : '');
      heading.textContent = dayHeading(dateKey);
      container.appendChild(heading);

      const maxEvents = dayCount === 0 ? 3 : 2;
      for (const ev of dayEvents.slice(0, maxEvents)) {
        const row = document.createElement('div');
        row.className = 'event-row';

        const bar = document.createElement('div');
        bar.className = 'event-bar';
        bar.style.background = ev.color;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time' + (ev.allDay ? ' allday' : '');
        timeEl.textContent = fmtTime(ev.start, ev.allDay);

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = ev.title;

        row.append(bar, timeEl, titleEl);
        container.appendChild(row);
      }
      if (dayEvents.length > maxEvents) {
        const more = document.createElement('div');
        more.className = 'no-events';
        more.textContent = `+${dayEvents.length - maxEvents} more`;
        container.appendChild(more);
      }

      dayCount++;
    }
  } catch (err) {
    console.warn('Calendar unavailable:', err.message);
  }
}
loadCalendar();

// ── Signal readiness for Puppeteer ───────────────────────────────────────────
// Puppeteer can wait for this before screenshotting
Promise.all([loadPhotos(), loadWeather(), loadBirthdays(), loadCalendar()])
  .then(() => { document.body.dataset.ready = 'true'; })
  .catch(() => { document.body.dataset.ready = 'true'; });
