const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarHandler } = require('../server');

process.env.TZ = 'America/Los_Angeles';
const now = new Date(2026, 10, 22, 12).valueOf();
function setup(t, replies) {
  const calls = [];
  const handler = createCalendarHandler({
    calendars: Object.keys(replies).map(name => ({ name, url: 'https://fixture.invalid/' + name })),
    cache: { calendar: 300_000 }, calendarDays: 14,
  }, () => now);
  t.mock.method(globalThis, 'fetch', async url => {
    const name = new URL(url).pathname.slice(1);
    calls.push(name);
    const reply = replies[name];
    if (reply instanceof Error) throw reply;
    return typeof reply === 'number' ? new Response(null, { status: reply }) : new Response(reply);
  });
  async function get(query) {
    let body;
    await handler({ query }, { json(data) { body = data; } });
    return body;
  }
  return { calls, get };
}

const feed = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:long-series',
  'DTSTART:20190101T100000', 'DTEND:20190101T110000', 'RRULE:FREQ=DAILY',
  'SUMMARY:Daily practice', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

test('long daily recurrence reaches today and lookback starts at local midnight', async t => {
  const { get, calls } = setup(t, { Practice: feed });
  const dates = data => data.events.map(e => e.start.slice(0, 10));
  assert.deepEqual(dates(await get({ days: '1' })), ['2026-11-22', '2026-11-23']);
  assert.deepEqual(dates(await get({ days: '1', pastDays: '0' })), ['2026-11-22', '2026-11-23']);
  const lookback = { days: '1', pastDays: '2' };
  assert.deepEqual(dates(await get(lookback)), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
  await get(lookback);
  assert.equal(calls.length, 2);
});

test('calendar query bounds normalize cache keys', async t => {
  const { get, calls } = setup(t, { Empty: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR' });
  for (const days of ['-8', '0', '1']) await get({ days, pastDays: '35' });
  await get({ days: '1', pastDays: '31' });
  assert.equal(calls.length, 1);
  for (const days of ['121', '120']) await get({ days, pastDays: '-2' });
  await get({ days: '120', pastDays: '0' });
  assert.equal(calls.length, 2);
  await get({ days: ['9'], pastDays: ['2'] });
  await get({ days: '14', pastDays: '0' });
  assert.equal(calls.length, 3);
});

test('total feed failure is named, URL-free and retried immediately', async t => {
  const replies = { One: new Error('could not fetch https://fixture.invalid/One'), Two: 503 };
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const { get, calls } = setup(t, replies);
  const failed = await get({});
  assert.equal(failed.error, true);
  assert.deepEqual(failed.events, []);
  assert.deepEqual(failed.failed, ['One', 'Two']);
  replies.One = feed;
  const partial = await get({});
  assert.ok(partial.events.length);
  assert.ok(!partial.error);
  assert.deepEqual(partial.failed, ['Two']);
  await get({});
  assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify([failed, partial, logs]), /fixture\.invalid/);
});

test('no configured calendars keeps the setup response', async t => {
  const { get } = setup(t, {});
  const data = await get({});
  assert.equal(data.unconfigured, true);
  assert.deepEqual(data.events, []);
  assert.deepEqual(data.failed, []);
  assert.ok(!data.error);
});
