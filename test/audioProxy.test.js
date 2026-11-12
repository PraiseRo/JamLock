// Integration-style tests for the audio byte-range proxy.
// Uses injected format lookup/fetch so no network or real extraction is required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { handleAudioProxy } from '../server/audioResolver.js';

const silentLogger = { warn() {}, log() {}, error() {} };
const VIDEO_ID = 'dQw4w9WgXcQ';

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  json(payload) {
    this.headersSent = true;
    this.setHeader('content-type', 'application/json');
    this.end(JSON.stringify(payload));
    return this;
  }

  end(chunk, encoding, callback) {
    this.headersSent = true;
    return super.end(chunk, encoding, callback);
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function makeReq(range) {
  return {
    params: { videoId: VIDEO_ID },
    headers: range ? { range } : {}
  };
}

test('audio proxy returns 404 when extraction fails', async () => {
  const res = new FakeResponse();
  await handleAudioProxy(makeReq(), res, {
    getFormat: async () => null,
    logger: silentLogger
  });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), {
    error: 'Audio stream unavailable',
    reason: 'extract-failed'
  });
});

test('audio proxy forwards range requests and 206 metadata', async () => {
  const body = Buffer.from('abcd');
  const res = new FakeResponse();
  const finished = once(res, 'finish');

  await handleAudioProxy(makeReq('bytes=0-3'), res, {
    getFormat: async () => ({ url: 'https://upstream.test/audio', mimeType: 'audio/mp4', provider: 'ytdl' }),
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.range, 'bytes=0-3');
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': 'audio/mp4',
          'content-range': 'bytes 0-3/10',
          'content-length': '4'
        }
      });
    },
    logger: silentLogger
  });
  await finished;

  assert.equal(res.statusCode, 206);
  assert.equal(res.getHeader('content-range'), 'bytes 0-3/10');
  assert.equal(res.getHeader('content-length'), '4');
  assert.equal(res.getHeader('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.concat(res.chunks), body);
});

test('audio proxy refreshes the format after an upstream 403', async () => {
  const formats = [
    { url: 'https://blocked.test/first', mimeType: 'audio/mp4', provider: 'ytdl' },
    { url: 'https://working.test/second', mimeType: 'audio/mp4', provider: 'piped:working.test' }
  ];
  const seenOptions = [];
  const requested = [];
  const res = new FakeResponse();
  const finished = once(res, 'finish');

  await handleAudioProxy(makeReq(), res, {
    getFormat: async (videoId, options = {}) => {
      seenOptions.push(options);
      return formats[0] && requested.length === 0
        ? formats[0]
        : (options.forceRefresh ? formats[1] : formats[0]);
    },
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.includes('blocked.test')) return new Response('denied', { status: 403 });
      return new Response('ok', { status: 200, headers: { 'content-type': 'audio/mp4' } });
    },
    logger: silentLogger
  });
  await finished;

  assert.equal(requested[0], formats[0].url);
  assert.equal(requested[1], formats[1].url);
  assert.equal(seenOptions[1].forceRefresh, true);
  assert.equal(seenOptions[1].skipYtdl, true);
  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(res.chunks).toString(), 'ok');
});

test('audio proxy returns 502 when both format attempts are rejected', async () => {
  const res = new FakeResponse();

  await handleAudioProxy(makeReq(), res, {
    getFormat: async () => ({ url: 'https://blocked.test/audio', mimeType: 'audio/mp4', provider: 'ytdl' }),
    fetchImpl: async () => new Response('nope', { status: 410 }),
    logger: silentLogger
  });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), {
    error: 'Audio upstream failed',
    reason: 'upstream-403'
  });
});

test('audio proxy returns 504 when the upstream never responds', async () => {
  const res = new FakeResponse();

  await handleAudioProxy(makeReq(), res, {
    getFormat: async () => ({ url: 'https://slow.test/audio', mimeType: 'audio/mp4', provider: 'ytdl' }),
    fetchImpl: async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
    upstreamTimeoutMs: 25,
    logger: silentLogger
  });

  assert.equal(res.statusCode, 504);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), {
    error: 'Audio upstream timed out',
    reason: 'timeout'
  });
});

test('audio proxy returns 500 for an unexpected upstream error', async () => {
  const res = new FakeResponse();

  await handleAudioProxy(makeReq(), res, {
    getFormat: async () => ({ url: 'https://broken.test/audio', mimeType: 'audio/mp4', provider: 'ytdl' }),
    fetchImpl: async () => {
      throw new Error('socket exploded');
    },
    logger: silentLogger
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), {
    error: 'Audio stream error',
    reason: 'server-error'
  });
});
