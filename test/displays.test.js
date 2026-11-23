const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'America/Los_Angeles';
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  children = [];
  dataset = {};
  style = {};
  listeners = {};
  classList = { add() {}, remove() {} };
  set innerHTML(html) { this.html = html; this.children = []; }
  get innerHTML() { return this.html ?? ''; }
  append(...els) { this.children.push(...els); }
  appendChild(el) { this.append(el); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
}

const calendar = { events: [], failed: [], windowEnd: '2026-11-26T12:00:00-08:00' };
const weather = {
  icon: 'sun', daily: [21, 22, 23, 24, 25].map(day => ({ date: '2026-11-' + day, high: day, icon: 'day' + day })),
};
async function display(script, replies = {}, initialDate = '2026-11-22T12:00:00') {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let time = new Date(initialDate).valueOf();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const defaults = { '/api/photos': [], '/api/weather': weather, '/api/birthdays': [], '/api/calendar': calendar };
  const requests = [];
  const images = [];
  const timers = new Map();
  let nextId = 0;
  function timer(fn, delay) {
    timers.set(++nextId, { fn, delay });
    return nextId;
  }
  const context = vm.createContext({
    Date: Clock,
    document: {
      body: new Element(), getElementById: element, createElement: () => new Element(),
      addEventListener() {}, querySelectorAll: () => [],
    },
    Image: class {
      constructor() { images.push(this); }
      removeAttribute(name) { delete this[name]; }
    },
    setInterval: timer, setTimeout: timer, clearTimeout: id => timers.delete(id),
    console: { warn() {} },
    async fetch(url) {
      requests.push(url);
      const route = url.split('?')[0];
      const result = replies[route] ?? defaults[route];
      if (result instanceof Error) throw result;
      return { ok: true, json: async () => result };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', script), 'utf8'), context);
  await settle();
  return {
    element, requests, images, replies,
    run: js => vm.runInContext(js, context),
    tick(ms) { time += ms; },
    async fire(delay, once = false, name) {
      const entries = [...timers].filter(([, timer]) => timer.delay === delay && (!name || timer.fn.name === name));
      assert.equal(entries.length, 1, 'one active timer at ' + delay + 'ms');
      const [id, timer] = entries[0];
      if (once) timers.delete(id);
      timer.fn();
      await settle();
    },
  };
}

test('photo lists retry on error and empty, then refresh hourly while old photos still cycle', async () => {
  const d = await display('app.js', { '/api/photos': new Error('offline') });
  d.replies['/api/photos'] = [];
  await d.fire(60_000, true);
  d.replies['/api/photos'] = ['first', 'second'];
  await d.fire(60_000, true);
  assert.equal(d.images[0].src, 'first');
  d.images[0].onload();
  await settle();
  // The birthday refresh also runs hourly. Select the photo refresh by its request.
  d.replies['/api/photos'] = [];
  await d.fire(60 * 60_000, true, 'loadPhotos');
  await d.fire(30_000);
  assert.equal(d.images.at(-1).src, 'second');
  d.replies['/api/photos'] = ['replacement'];
  await d.fire(60_000, true);
  d.images.at(-1).onload();
  await settle();
  if (d.images.at(-1).src !== 'replacement') await d.fire(30_000);
  assert.equal(d.images.at(-1).src, 'replacement');
});

test('a stalled preload releases the slideshow after a list replacement', async () => {
  const d = await display('app.js', { '/api/photos': ['stalled'] });
  const stalled = d.images[0];
  d.replies['/api/photos'] = ['fresh'];
  await d.fire(60 * 60_000, true, 'loadPhotos');
  assert.equal(d.images.length, 1);
  await d.fire(20_000, true);
  assert.equal(stalled.src, undefined);
  assert.deepEqual(d.images.slice(1).map(img => img.src), ['fresh']);
});

test('image preload and delayed retries form one bounded pass', async () => {
  const d = await display('app.js', { '/api/photos': ['a', 'b'] });
  await d.fire(30_000);
  assert.deepEqual(d.images.map(i => i.src), ['a']);
  d.images[0].onerror();
  await settle();
  await d.fire(30_000);
  assert.equal(d.images.length, 1);
  await d.fire(3_000, true);
  assert.deepEqual(d.images.map(i => i.src), ['a', 'b']);
  d.images[1].onerror();
  await settle();
  assert.equal(d.images.length, 2);
  await d.fire(30_000);
  assert.deepEqual(d.images.map(i => i.src), ['a', 'b', 'a']);
});

test('portrait fetches each panel once before setting data-ready', async () => {
  const d = await display('portrait.js');
  assert.deepEqual(d.requests.sort(), ['/api/birthdays', '/api/calendar', '/api/photos?orientation=portrait', '/api/weather']);
  assert.equal(d.run('document.body.dataset.ready'), 'true');
});

for (const script of ['app.js', 'portrait.js']) {
  test(script + ' labels tomorrow across both DST changes', async () => {
    for (const [today, tomorrow] of [['2026-03-07T23:30:00', '2026-03-08'], ['2026-11-01T00:30:00', '2026-11-02']]) {
      const d = await display(script, {}, today);
      assert.equal(d.run('dayHeading("' + tomorrow + '")'), 'Tomorrow');
    }
  });

  test(script + ' displays events from a server still serving the previous calendar response', async () => {
    const events = [{ start: '2026-11-23T12:00:00', title: 'Lunch' }];
    const d = await display(script, { '/api/calendar': { events } });
    const el = d.element(script === 'app.js' ? 'eventsInner' : 'eventsPanel');
    assert.ok(el.children.length);
  });

  test(script + ' reports a total calendar outage', async () => {
    const d = await display(script, { '/api/calendar': { ...calendar, error: true } });
    const el = d.element(script === 'app.js' ? 'eventsInner' : 'eventsPanel');
    assert.match(el.innerHTML, /Calendar unavailable/);
    if (script === 'app.js') {
      await d.run('openCalendarModal()');
      assert.match(d.element('calDayPanel').innerHTML, /Calendar unavailable/);
    }
  });

  test(script + ' groups ongoing, all-day, overnight, and instant events inside the view', async () => {
    const event = (title, start, end, allDay = false) => ({ title, start, end, allDay });
    const events = [
      event('Trip', '2026-11-20T00:00:00', '2026-11-24T00:00:00', true),
      event('Night', '2026-11-22T22:00:00', '2026-11-23T02:00:00'),
      event('Midnight finish', '2026-11-23T14:00:00', '2026-11-24T00:00:00'),
      event('Instant', '2026-11-24T00:00:00', '2026-11-24T00:00:00'),
      event('Long stay', '2026-11-25T08:00:00', '2027-02-01T00:00:00'),
    ];
    const d = await display(script, { '/api/calendar': { ...calendar, events } });
    if (script === 'app.js') {
      const cols = d.element('eventsInner').children;
      assert.deepEqual(cols.map(col => col.children[0].textContent),
        ['Today', 'Tomorrow', 'Tuesday, Nov 24', 'Wednesday, Nov 25', 'Thursday, Nov 26']);
      assert.deepEqual(cols.map(col => col.children.slice(1).map(row => row.children[1].children[1].textContent)), [
        ['Trip', 'Night'], ['Trip', 'Night', 'Midnight finish'], ['Instant'], ['Long stay'], ['Long stay'],
      ]);
      await d.run('openCalendarModal()');
      const select = day => d.element('calGrid').children.find(c => c.children[0]?.textContent === day).listeners.click();
      select(21);
      assert.equal(d.element('calDayPanel').children.at(-1).children[2].textContent, 'Trip');
      select(24);
      assert.equal(d.element('calDayPanel').children.length, 1);
    } else {
      const rows = d.element('eventsPanel').children;
      assert.deepEqual(rows.filter(el => el.className.startsWith('day-heading')).map(el => el.textContent),
        ['Today', 'Tomorrow', 'Tuesday, Nov 24']);
      assert.deepEqual(rows.filter(el => el.className === 'event-row').map(el => el.children[2].textContent),
        ['Trip', 'Night', 'Trip', 'Night', 'Instant']);
    }
  });
}

test('month modal caches empty successes for five minutes and indexes distant birthdays', async () => {
  const d = await display('app.js', { '/api/birthdays': [{ name: 'June', month: 6, day: 7, daysUntil: 197 }] });
  assert.equal(d.run('birthdaysByDate["06-07"]?.[0]'), 'June');
  const open = () => d.run('openCalendarModal()');
  await open();
  await open();
  const queries = () => d.requests.filter(url => url.startsWith('/api/calendar?'));
  assert.deepEqual(queries(), ['/api/calendar?days=90&pastDays=21']);
  d.replies['/api/calendar'] = { ...calendar, events: [{ start: '2026-11-23T12:00:00', title: 'Lunch' }] };
  d.tick(300_001);
  await open();
  assert.equal(queries().length, 2);
  d.tick(300_001);
  await open();
  assert.equal(queries().length, 3);
});

test('weather renders future days, opens on today and hides after two hours until recovery', async () => {
  const d = await display('app.js');
  const forecast = d.element('weatherForecast').innerHTML;
  assert.doesNotMatch(forecast, /day22/);
  assert.match(forecast, /day23/);
  assert.match(forecast, /day25/);
  d.run("expandedForecastDate = '2026-11-24'; openWeatherModal()");
  assert.equal(d.run('expandedForecastDate'), '2026-11-22');
  d.replies['/api/weather'] = new Error('offline');
  d.tick(119 * 60_000);
  await d.run('loadWeather()');
  assert.equal(d.element('weatherBlock').style.display, '');
  d.tick(2 * 60_000);
  await d.fire(2 * 60 * 60_000, true);
  await d.run('loadWeather()');
  assert.equal(d.element('weatherBlock').style.display, 'none');
  d.replies['/api/weather'] = weather;
  await d.run('loadWeather()');
  assert.equal(d.element('weatherBlock').style.display, '');
});
