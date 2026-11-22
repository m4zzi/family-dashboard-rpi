const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IncomingMessage, ServerResponse } = require('node:http');
const express = require('express');
const {
  parseAlbumGuid, photosFromRecords, filterPhotosByOrientation, fetchSharedAlbumPhotos, registerSharedAlbumRoutes,
} = require('../server');

const guid = 'Album_X-7';
const albumUrl = 'https://photos.icloud.com/shared/album/Album_X-7';
const zoneID = { zoneName: 'album', ownerRecordName: 'owner', zoneType: 'REGULAR_CUSTOM_ZONE' };
const access = { token: 'example+token/=', databasePartition: 'https://partition.invalid/' };
const resolved = { results: [{ zoneID, anonymousPublicAccess: access }] };

function rendition(slot, name, width, height, type) {
  const prefix = 'res' + slot;
  const fields = {
    [prefix + 'Res']: { value: { downloadURL: 'https://cdn.invalid/' + name + '/${f}?name=${f}' } },
    [prefix + 'Width']: { value: width },
    [prefix + 'Height']: { value: height },
  };
  if (type) fields[prefix + 'FileType'] = { value: type };
  return fields;
}

function asset(masterName, fields = {}) {
  return { recordType: 'CPLAsset', recordName: 'asset-' + masterName, fields: {
    masterRef: { value: { recordName: masterName } }, ...fields,
  } };
}

function master(recordName, fields = {}, dataClass = 1) {
  return { recordType: 'CPLMaster', recordName, fields: {
    dataClassType: { value: dataClass }, ...fields,
  } };
}

test('shortGUIDs and public album links resolve to the same case-sensitive identifier', () => {
  for (const input of [guid, albumUrl, albumUrl + '/?view=grid#photo']) {
    assert.equal(parseAlbumGuid(input), guid);
  }
  for (const input of ['', 'https://other.invalid/shared/album/Album_X-7',
    'https://www.icloud.com/sharedalbum/#OLD', albumUrl + '/other']) {
    assert.throws(() => parseAlbumGuid(input), /Invalid iCloud/);
  }
});

test('pairs unordered records and chooses by long side, including exactly 1920', () => {
  const records = [
    asset('tall', {
      ...rendition('JPEGFull', 'full', 3000, 4000),
      ...rendition('JPEGLarge', 'large', 1536, 2048),
      ...rendition('JPEGMed', 'screen', 1440, 1920),
      ...rendition('JPEGThumb', 'thumb', 360, 480),
    }),
    master('wide', rendition('Original', 'original', 6000, 4000, 'public.jpeg')),
    master('tall'),
    asset('wide', {
      ...rendition('JPEGThumb', 'small', 480, 270),
      ...rendition('JPEGMed', 'wide', 1280, 720),
    }),
  ];
  assert.deepEqual(photosFromRecords(records), [
    { id: 'asset-tall', url: 'https://cdn.invalid/screen/public.jpeg?name=public.jpeg', width: 1440, height: 1920 },
    { id: 'asset-wide', url: 'https://cdn.invalid/wide/public.jpeg?name=public.jpeg', width: 1280, height: 720 },
  ]);
});

test('selects the master JPEGMed when the asset has only a master reference', () => {
  const records = [
    asset('portrait'),
    master('portrait', {
      ...rendition('JPEGThumb', 'thumb', 339, 508, 'public.jpeg'),
      ...rendition('JPEGMed', 'medium', 1448, 2172, 'public.jpeg'),
      ...rendition('Original', 'original', 4640, 6960, 'public.jpeg'),
    }),
  ];
  assert.deepEqual(photosFromRecords(records), [
    { id: 'asset-portrait', url: 'https://cdn.invalid/medium/public.jpeg?name=public.jpeg', width: 1448, height: 2172 },
  ]);
});

test('uses JPEG originals as a fallback and excludes other originals and movie previews', () => {
  const records = [
    master('heic', rendition('Original', 'heic', 4000, 3000, 'public.heic')), asset('heic'),
    asset('movie', rendition('JPEGLarge', 'preview', 1920, 1080)), master('movie', {}, 2),
    asset('unknown'), master('unknown', rendition('Original', 'unknown', 1000, 1000)),
    asset('still'), master('still', rendition('Original', 'still', 1200, 900, 'public.jpeg')),
  ];
  assert.deepEqual(photosFromRecords(records), [
    { id: 'asset-still', url: 'https://cdn.invalid/still/public.jpeg?name=public.jpeg', width: 1200, height: 900 },
  ]);
});

test('orientation includes squares on both pages and falls back to the whole album', () => {
  const wide = { width: 1920, height: 1080, url: 'wide' };
  const tall = { width: 1080, height: 1920, url: 'tall' };
  const square = { width: 1200, height: 1200, url: 'square' };
  const photos = [wide, tall, square];
  assert.deepEqual(filterPhotosByOrientation(photos, 'landscape'), [wide, square]);
  assert.deepEqual(filterPhotosByOrientation(photos, 'portrait'), [tall, square]);
  assert.deepEqual(filterPhotosByOrientation(photos), [wide, tall, square]);
  assert.deepEqual(filterPhotosByOrientation([wide], 'portrait'), [wide]);
  assert.deepEqual(filterPhotosByOrientation([tall], 'landscape'), [tall]);
  assert.deepEqual(filterPhotosByOrientation([], 'portrait'), []);
});

test('an incomplete asset or master leaves other photos available', () => {
  const records = [
    { recordType: 'CPLAsset' },
    { recordType: 'CPLMaster', recordName: 'incomplete' }, asset('incomplete'),
    master('wide'), asset('wide', rendition('JPEGMed', 'wide', 1920, 1080)),
  ];
  assert.deepEqual(photosFromRecords(records), [
    { id: 'asset-wide', url: 'https://cdn.invalid/wide/public.jpeg?name=public.jpeg', width: 1920, height: 1080 },
  ]);
});

test('resolves once and queries the returned zone in 30-asset pages', async t => {
  const responses = [
    resolved,
    { records: [{ recordType: 'IndexCountResult', fields: { itemCount: { value: 31 } } }] },
    { records: Array.from({ length: 30 }, (_, i) => [asset('movie' + i), master('movie' + i, {}, 2)]).flat() },
    { records: [asset('last', rendition('JPEGMed', 'last', 1920, 1080)), master('last')] },
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => responses.shift() };
  });
  assert.deepEqual(await fetchSharedAlbumPhotos(albumUrl), [
    { id: 'asset-last', url: 'https://cdn.invalid/last/public.jpeg?name=public.jpeg', width: 1920, height: 1080 },
  ]);
  assert.equal(requests.length, 4);
  const [resolve, count, first, last] = requests;
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Origin, 'https://photos.icloud.com');
    const params = request.url.searchParams;
    assert.equal(params.get('remapEnums'), 'true');
    assert.equal(params.get('getCurrentSyncToken'), 'true');
    assert.equal(params.get('sharing_url_key'), guid);
    assert.equal(params.get('clientBuildNumber'), '2642Build18');
    assert.equal(params.get('clientMasteringNumber'), '2642Build18');
  }
  assert.equal(resolve.url.origin, 'https://ckdatabasews.icloud.com');
  assert.equal(resolve.url.pathname, '/database/1/com.apple.photos.cloud/production/public/records/resolve');
  assert.equal(resolve.headers['Content-Type'], 'text/plain');
  assert.equal(resolve.url.searchParams.has('clientId'), false);
  assert.deepEqual(resolve.body, { shortGUIDs: [{ value: guid }] });

  const client = count.url.searchParams.get('clientId');
  assert.match(client, /^[0-9a-f-]{36}$/);
  for (const request of [count, first, last]) {
    assert.equal(request.url.origin, 'https://partition.invalid');
    assert.equal(request.url.pathname, '/database/1/com.apple.photos.cloud/production/shared/records/query');
    assert.equal(request.url.searchParams.get('publicAccessAuthToken'), access.token);
    assert.equal(request.url.searchParams.get('clientId'), client);
    assert.deepEqual(request.body.zoneID, zoneID);
    assert.equal(request.headers['Content-Type'], 'text/plain;charset=UTF-8');
  }
  assert.deepEqual(count.body.query, { recordType: 'HyperionIndexCountLookup', filterBy: [
    { fieldName: 'indexCountID', comparator: 'IN', fieldValue: { type: 'STRING_LIST', value: ['CPLAssetByAddedDate'] } },
  ] });
  for (const [page, rank, limit] of [[first, 0, 60], [last, 30, 2]]) {
    assert.equal(page.body.resultsLimit, limit);
    assert.deepEqual(page.body.query, { recordType: 'CPLAssetAndMasterByAddedDate', filterBy: [
      { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: 'ASCENDING' } },
      { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { type: 'INT64', value: rank } },
    ] });
  }
});

test('distinguishes an empty public album from missing access or a failed count', async t => {
  const responses = [
    resolved, { records: [{ recordType: 'IndexCountResult', fields: { count: { value: 0 } } }] },
    { results: [{ zoneID }] },
    resolved, { records: [] },
  ];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => responses.shift() }));
  assert.deepEqual(await fetchSharedAlbumPhotos(guid), []);
  await assert.rejects(fetchSharedAlbumPhotos(guid), /public access/);
  await assert.rejects(fetchSharedAlbumPhotos(guid), /album count/);
});

const fetchedAt = 1_800_000_000_000;
const widePhoto = { id: 'asset/a', width: 1920, height: 1080, url: 'https://cdn.invalid/wide?e=1800000900' };
const tallPhoto = { id: 'tall', width: 1080, height: 1920, url: 'https://cdn.invalid/tall?e=1800001800' };
const widePath = '/api/photos/img/asset%2Fa';

// Dispatch through Express in memory so routing, ID decoding and response headers are exercised.
function albumClient(load, now = () => fetchedAt) {
  const app = express();
  registerSharedAlbumRoutes(app, load, now);
  return url => new Promise((resolve, reject) => {
    const req = new IncomingMessage();
    req.method = 'GET';
    req.url = url;
    const res = new ServerResponse(req);
    res.end = body => resolve({ status: res.statusCode, headers: res.getHeaders(), body: body?.toString() });
    app(req, res, err => reject(err || new Error('Unhandled route ' + url)));
  });
}

test('lists stable encoded asset paths and redirects to the selected signed rendition', async () => {
  const load = () => [widePhoto, { ...tallPhoto, id: "kid's photo" }];
  const get = albumClient(load);
  const list = await get('/api/photos');
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body).sort(), ['/api/photos/img/asset%2Fa', '/api/photos/img/kid%27s%20photo']);
  const landscape = await get('/api/photos?orientation=landscape');
  assert.deepEqual(JSON.parse(landscape.body), ['/api/photos/img/asset%2Fa']);
  const image = await get(widePath);
  assert.equal(image.status, 302);
  assert.equal(image.headers.location, widePhoto.url);
  assert.equal(image.headers['cache-control'], 'no-store');
});

test('at the earliest expiry minus two minutes list and image requests share one refresh', async () => {
  let time = fetchedAt;
  let finishRefresh;
  let calls = 0;
  const get = albumClient(() => {
    if (++calls === 1) return [tallPhoto, widePhoto];
    return new Promise(resolve => { finishRefresh = resolve; });
  }, () => time);
  await get('/api/photos');
  time += 13 * 60_000 - 1;
  assert.equal((await get(widePath)).headers.location, widePhoto.url);
  assert.equal(calls, 1);
  time++;
  const list = get('/api/photos');
  const wide = get(widePath);
  const tall = get('/api/photos/img/tall');
  assert.equal(calls, 2);
  const updatedWide = { ...widePhoto, url: 'https://cdn.invalid/new-wide?e=1800002400' };
  const updatedTall = { ...tallPhoto, url: 'https://cdn.invalid/new-tall?e=1800002400' };
  finishRefresh([updatedWide, updatedTall]);
  assert.deepEqual(JSON.parse((await list).body).sort(), ['/api/photos/img/asset%2Fa', '/api/photos/img/tall']);
  assert.equal((await wide).headers.location, updatedWide.url);
  assert.equal((await tall).headers.location, updatedTall.url);
});

test('a near-expiry image refreshes even during the one-minute album cache minimum', async () => {
  let time = fetchedAt;
  let calls = 0;
  const short = { ...widePhoto, url: 'https://cdn.invalid/short?e=1800000125' };
  const get = albumClient(() => ++calls === 1 ? [short] : [widePhoto], () => time);
  await get('/api/photos');
  time += 5_000;
  await get('/api/photos');
  assert.equal(calls, 1);
  assert.equal((await get(widePath)).headers.location, widePhoto.url);
  assert.equal(calls, 2);
});

test('an image without e is valid for ten minutes from fetch', async () => {
  let time = fetchedAt;
  let calls = 0;
  const unsigned = { ...widePhoto, url: 'https://cdn.invalid/no-expiry' };
  const get = albumClient(() => ++calls === 1 ? [unsigned] : [widePhoto], () => time);
  await get('/api/photos');
  time += 10 * 60_000 - 1;
  assert.equal((await get(widePath)).headers.location, unsigned.url);
  time++;
  assert.equal((await get(widePath)).headers.location, widePhoto.url);
  assert.equal(calls, 2);
});

test('even long-lived URLs expire from the album cache after one hour', async () => {
  let time = fetchedAt;
  let calls = 0;
  const get = albumClient(() => {
    calls++;
    return [{ ...widePhoto, url: 'https://cdn.invalid/long?e=1800010000' }];
  }, () => time);
  await get('/api/photos');
  time += 60 * 60_000 - 1;
  await get('/api/photos');
  assert.equal(calls, 1);
  time++;
  await get('/api/photos');
  assert.equal(calls, 2);
});

test('a missing ID is checked against one fresh album before returning 404', async () => {
  let calls = 0;
  const get = albumClient(() => ++calls === 1 ? [] : [widePhoto]);
  const missing = await get('/api/photos/img/missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.equal(calls, 1);
  assert.equal((await get(widePath)).headers.location, widePhoto.url);
  assert.equal(calls, 2);
});

test('a failed refresh returns 502 and the next request retries', async () => {
  let time = fetchedAt;
  let calls = 0;
  const get = albumClient(() => {
    if (++calls === 2) throw new Error('fixture upstream failure');
    return calls === 1 ? [widePhoto] : [tallPhoto];
  }, () => time);
  await get('/api/photos');
  time += 15 * 60_000;
  const failed = await get(widePath);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal(failed.body, 'Unable to load photo album');
  assert.equal((await get('/api/photos/img/tall')).headers.location, tallPhoto.url);
  assert.equal(calls, 3);
});

test('a refresh that returns an expired link can be retried immediately', async () => {
  const expired = { ...widePhoto, url: 'https://cdn.invalid/old?e=1799999999' };
  let calls = 0;
  const get = albumClient(() => ++calls === 1 ? [expired] : [widePhoto]);
  const failed = await get(widePath);
  assert.equal(failed.status, 502);
  assert.equal(failed.headers['cache-control'], 'no-store');
  assert.equal((await get(widePath)).headers.location, widePhoto.url);
  assert.equal(calls, 2);
});
