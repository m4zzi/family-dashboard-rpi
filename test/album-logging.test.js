const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerSharedAlbumRoutes } = require('../server');

test('both album routes log upstream errors without signed URLs', async t => {
  const routes = {};
  registerSharedAlbumRoutes({ get(path, handler) { routes[path] = handler; } }, () => {
    throw new Error('upstream timed out at https://fixture.invalid/photo?signature=private-fixture');
  });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const res = { set() { return this; }, status() { return this; }, json() {}, send() {} };
  for (const handler of Object.values(routes)) await handler({ query: {}, params: { id: 'test' } }, res);
  assert.equal(errors.length, 2);
  for (const message of errors) {
    assert.match(message, /upstream timed out/);
    assert.doesNotMatch(message, /fixture\.invalid|private-fixture/);
  }
});
