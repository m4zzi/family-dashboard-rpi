const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { main, waitForPortrait } = require('../meural-push');

const config = {
  meural: {
    cognitoRegion: 'fixture', galleryName: 'Fixture',
    devices: [{ name: 'Test frame', ip: 'frame.invalid', id: 'frame' }],
  },
  gatus: { framesPushUrl: 'https://beat.invalid/frames', pushUrl: 'https://beat.invalid/cloud', token: 'fixture' },
};

async function runPush(t, replies, resync = true, shots = ['fixture.jpg']) {
  const calls = [];
  const warnings = [];
  const unexpected = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  // All lock and screenshot operations stay in memory.
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'writeFileSync', () => {});
  t.mock.method(fs, 'unlinkSync', () => {});
  t.mock.method(fs, 'readFileSync', () => Buffer.from('fixture image'));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const { pathname, search } = new URL(url);
    const key = (options.method || 'GET') + ' ' + pathname + search;
    calls.push(key);
    const fixture = replies[key];
    const reply = Array.isArray(fixture) ? fixture.shift() : fixture;
    if (!reply || !options.signal) {
      unexpected.push(key);
      throw new Error('Unexpected fixture request');
    }
    if (reply instanceof Error) throw reply;
    if (reply.status === 204) return new Response(null, { status: 204 });
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  });
  const capture = async () => { calls.push('capture'); return shots; };
  await main(config, { resync, capture });
  assert.deepEqual(unexpected, []);
  return { calls, warnings };
}

const auth = { 'POST /': { body: { AuthenticationResult: { AccessToken: 'fixture' } } } };
const durations = { 'PUT /v0/devices/frame': {} };
const gallery = {
  'GET /v0/user/galleries?count=1000': { body: { data: [{ id: 'gallery', name: 'Fixture' }] } },
  'GET /v0/galleries/gallery/items?count=1000': { body: { data: [{ id: 'old' }] } },
  'POST /v0/items': { body: { data: { id: 'new' } } },
};
const delivery = { 'POST /remote/postcard': {}, 'POST /frames?success=true': {} };
const cloudDown = { 'POST /cloud?success=false': {} };

for (const [label, reply, warning] of [
  ['unreachable', new Error('offline'), /offline/i],
  ['challenge', { body: { ChallengeName: 'TEST_CHALLENGE' } }, /challenge/i],
]) {
  test('nightly postcard and heartbeats survive ' + label + ' auth', async t => {
    const { calls, warnings } = await runPush(t, { 'POST /': reply, ...delivery, ...cloudDown });
    assert.deepEqual(calls, ['POST /', 'capture', ...Object.keys(delivery), ...Object.keys(cloudDown)]);
    assert.match(warnings.join(' '), warning);
  });
}

test('ordinary push still reports delivery when auth fails', async t => {
  const { calls } = await runPush(t, { 'POST /': { status: 401 }, ...delivery }, false);
  assert.deepEqual(calls, ['POST /', 'capture', ...Object.keys(delivery)]);
});

test('nightly gallery discovery failure still delivers the postcard', async t => {
  const { calls } = await runPush(t, {
    ...auth, ...durations, 'GET /v0/user/galleries?count=1000': { status: 503 }, ...delivery, ...cloudDown,
  });
  assert.deepEqual(calls.slice(-3), [...Object.keys(delivery), ...Object.keys(cloudDown)]);
});

test('rejected gallery add stops uploads and preserves existing items', async t => {
  const { calls } = await runPush(t, {
    ...auth, ...durations, ...gallery, 'POST /v0/galleries/gallery/items/new': { status: 409 }, ...delivery, ...cloudDown,
  }, true, ['first.jpg', 'second.jpg']);
  assert.equal(calls.filter(c => c === 'POST /v0/items').length, 1);
  assert.deepEqual(calls.slice(-3), [...Object.keys(delivery), ...Object.keys(cloudDown)]);
});

test('a rejected device re-add leaves the frame on its delivered postcard', async t => {
  const { warnings, calls } = await runPush(t, {
    ...auth, ...durations, ...gallery, 'POST /v0/galleries/gallery/items/new': {},
    ...delivery, 'POST /cloud?success=true': {},
    'DELETE /v0/items/old': {}, 'DELETE /v0/devices/frame/galleries/gallery': { status: 400 },
    'POST /v0/devices/frame/galleries/gallery': { status: 503 },
  });
  assert.match(warnings.join(' '), /503/);
  assert.ok(calls.includes('POST /v0/devices/frame/galleries/gallery'));
  assert.equal(calls.some(c => c.includes('/remote/control_command')), false);
});

test('one accepted item permits cleanup, but rejected syncs never re-pin the frame', async t => {
  const { warnings, calls } = await runPush(t, {
    ...auth, ...durations, ...gallery, 'POST /v0/galleries/gallery/items/new': [{ status: 204 }, { status: 409 }],
    ...delivery, 'POST /cloud?success=true': {},
    'DELETE /v0/items/old': {}, 'DELETE /v0/devices/frame/galleries/gallery': {},
    'POST /v0/devices/frame/sync': [{ status: 502 }, { status: 503 }],
    'POST /v0/devices/frame/galleries/gallery': { status: 204 },
  }, true, ['one.jpg', 'two.jpg', 'three.jpg']);
  assert.equal(calls.filter(call => call === 'POST /v0/items').length, 2);
  assert.ok(calls.includes('DELETE /v0/items/old'));
  assert.ok(calls.includes('POST /cloud?success=true'));
  assert.match(warnings.join(' '), /502/);
  assert.match(warnings.join(' '), /503/);
  assert.equal(calls.some(call => call.includes('/remote/control_command')), false);
});

for (const [outcome, fatal] of [
  ['timeout', false], ['refused', true], ['HTTP error', true], ['HTTP error and timeout', true],
]) {
  test('portrait navigation handles ' + outcome, async () => {
    let ready = false;
    const frame = {};
    let onResponse;
    const response = {
      status: () => outcome.startsWith('HTTP') ? 503 : 200,
      request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
    };
    const page = {
      mainFrame: () => frame,
      on(name, fn) { if (name === 'response') onResponse = fn; },
      async goto() {
        if (outcome === 'refused') throw new Error('ERR_CONNECTION_REFUSED');
        onResponse?.(response);
        if (outcome.includes('timeout')) throw Object.assign(new Error('Navigation timeout'), { name: 'TimeoutError' });
        return response;
      },
      async waitForFunction() { ready = true; },
    };
    if (fatal) await assert.rejects(waitForPortrait(page, 'http://fixture.invalid'), outcome === 'refused' ? /REFUSED/ : /503/);
    else await waitForPortrait(page, 'http://fixture.invalid');
    assert.equal(ready, !fatal);
  });
}

test('an HTTP error arriving during the data-ready wait is fatal', async () => {
  const frame = {};
  let onResponse;
  const page = {
    mainFrame: () => frame,
    on(name, fn) { if (name === 'response') onResponse = fn; },
    async goto() { throw Object.assign(new Error('Navigation timeout'), { name: 'TimeoutError' }); },
    async waitForFunction() {
      onResponse({ status: () => 503, request: () => ({ isNavigationRequest: () => true, frame: () => frame }) });
      throw new Error('data-ready timed out');
    },
  };
  await assert.rejects(waitForPortrait(page, 'http://fixture.invalid'), /503/);
});
