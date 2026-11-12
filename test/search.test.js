// Unit tests for search response parsing and hard-deadline behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../server/search.js';

const renderer = {
  videoId: 'dQw4w9WgXcQ',
  title: { runs: [{ text: 'Test Song' }] },
  ownerText: { runs: [{ text: 'Test Artist - Topic' }] },
  lengthText: { simpleText: '3:05' },
  thumbnail: { thumbnails: [{ url: 'https://img.test/thumb.jpg' }] }
};

const youtubeData = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            { itemSectionRenderer: { contents: [{ videoRenderer: renderer }] } }
          ]
        }
      }
    }
  }
};

async function withMockFetch(mockFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('mapVideoRenderer converts durations and metadata', () => {
  const track = __test.mapVideoRenderer(renderer);
  assert.equal(track.id, 'dQw4w9WgXcQ');
  assert.equal(track.title, 'Test Song');
  assert.equal(track.artist, 'Test Artist - Topic');
  assert.equal(track.duration, '3:05');
  assert.equal(track.durationSeconds, 185);
  assert.equal(track.thumbnail, 'https://img.test/thumb.jpg');
  assert.equal(__test.mapVideoRenderer({}), null);
});

test('collectVideoRenderers walks nested results in order', () => {
  const second = { ...renderer, videoId: 'abcdefghijk', title: { runs: [{ text: 'Second' }] } };
  const data = {
    a: { b: [{ videoRenderer: renderer }, { c: { videoRenderer: second } }] }
  };
  const found = __test.collectVideoRenderers(data, 10);
  assert.deepEqual(found.map((v) => v.videoId), ['dQw4w9WgXcQ', 'abcdefghijk']);
  assert.equal(__test.collectVideoRenderers(data, 1).length, 1);
});

test('searchYouTubei parses a mocked JSON response', async () => {
  const items = await withMockFetch(
    async () => new Response(JSON.stringify(youtubeData), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }),
    () => __test.searchYouTubei('test song', 5, 500)
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Test Song');
});

test('searchYouTubei returns null when the body hangs past the deadline', async () => {
  const started = Date.now();
  const items = await withMockFetch(
    async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }),
    () => __test.searchYouTubei('slow', 5, 50)
  );

  assert.equal(items, null);
  assert.ok(Date.now() - started < 1000, 'deadline must cover the response body');
});

test('searchYouTubeHtml parses ytInitialData from a mocked page', async () => {
  const html = `<html><script>var ytInitialData = ${JSON.stringify(youtubeData)};</script></html>`;
  const items = await withMockFetch(
    async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    () => __test.searchYouTubeHtml('test song', 5, 500)
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'dQw4w9WgXcQ');
});

test('searchYouTubeHtml returns null when the data marker is missing', async () => {
  const items = await withMockFetch(
    async () => new Response('<html>no data here</html>', { status: 200 }),
    () => __test.searchYouTubeHtml('test song', 5, 500)
  );
  assert.equal(items, null);
});
