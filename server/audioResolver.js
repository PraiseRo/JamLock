// Direct YouTube Audio Stream Resolver & Byte-Range Proxy for Mobile Background Playback
// Uses @distube/ytdl-core (Ytdl) to extract native audio/mp4 (itag 140) streams so
// iOS Safari & Android Chrome keep <audio> playing when switching apps or locking the screen.

import { Ytdl, chooseFormat } from '@distube/ytdl-core';
import { Readable } from 'stream';

const ytdl = new Ytdl();

// Cache resolved format metadata per videoId (20-minute TTL)
const FORMAT_CACHE = new Map();
const FORMAT_TTL_MS = 1000 * 60 * 20;
const FORMAT_MAX = 400;
const INFLIGHT = new Map();

export async function getYoutubeAudioFormat(videoId) {
  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) return null;

  const cached = FORMAT_CACHE.get(videoId);
  if (cached && Date.now() - cached.timestamp < FORMAT_TTL_MS) {
    return cached.data;
  }

  if (INFLIGHT.has(videoId)) {
    return INFLIGHT.get(videoId);
  }

  const promise = (async () => {
    const startedAt = Date.now();
    try {
      const info = await ytdl.getInfo(videoId);
      const formats = Array.isArray(info?.formats) ? info.formats : [];

      // Prefer itag 140 (audio/mp4 AAC) — universally supported on iOS Safari AND Android Chrome
      const m4a140 = formats.find((f) => f.itag === 140 && f.url);
      const anyMp4Audio = formats
        .filter((f) => f.url && f.mimeType?.startsWith('audio/mp4'))
        .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0];
      const fallbackAudio = formats
        .filter((f) => f.url && f.mimeType?.startsWith('audio/'))
        .sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0))[0];

      const chosen = m4a140 || anyMp4Audio || fallbackAudio || chooseFormat(formats, { quality: 'highestaudio', filter: 'audioonly' });
      if (!chosen?.url) {
        console.warn(`[audio] extract FAILED id=${videoId} after ${Date.now() - startedAt}ms: no playable audio format (${formats.length} formats)`);
        return null;
      }

      const data = {
        url: chosen.url,
        mimeType: (chosen.mimeType || 'audio/mp4').split(';')[0].trim(),
        contentLength: Number(chosen.contentLength) || 0,
        itag: chosen.itag
      };

      if (FORMAT_CACHE.size >= FORMAT_MAX) {
        const oldest = FORMAT_CACHE.keys().next().value;
        FORMAT_CACHE.delete(oldest);
      }
      FORMAT_CACHE.set(videoId, { data, timestamp: Date.now() });
      console.log(`[audio] extract ok id=${videoId} itag=${data.itag} in ${Date.now() - startedAt}ms`);
      return data;
    } catch (err) {
      // Real reason stays in server logs only (never sent to clients)
      console.warn(`[audio] extract FAILED id=${videoId} after ${Date.now() - startedAt}ms: ${err?.message || err}`);
      return null;
    } finally {
      INFLIGHT.delete(videoId);
    }
  })();

  INFLIGHT.set(videoId, promise);
  return promise;
}

// Proxy audio stream with full HTTP 206 Byte-Range support for iOS Safari & Android lock-screen seeking
export async function streamAudioToClient(req, res) {
  const videoId = String(req.params.videoId || '').trim();
  const format = await getYoutubeAudioFormat(videoId);

  if (!format || !format.url) {
    console.warn(`[audio] stream 404 id=${videoId}: no format (extraction failed)`);
    res.status(404).json({ error: 'Audio stream unavailable', reason: 'extract-failed' });
    return;
  }

  const upstreamHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': '*/*'
  };

  if (req.headers.range) {
    upstreamHeaders.range = req.headers.range;
  }

  const abortController = new AbortController();
  req.on('close', () => {
    try { abortController.abort(); } catch (e) {}
  });

  try {
    let upstreamRes = await fetch(format.url, {
      headers: upstreamHeaders,
      signal: abortController.signal
    });

    // If cached googlevideo URL expired (403/410), refresh once and retry
    if (upstreamRes.status === 403 || upstreamRes.status === 410) {
      console.warn(`[audio] upstream ${upstreamRes.status} id=${videoId}: refreshing URL and retrying once`);
      FORMAT_CACHE.delete(videoId);
      const fresh = await getYoutubeAudioFormat(videoId);
      if (fresh?.url) {
        upstreamRes = await fetch(fresh.url, {
          headers: upstreamHeaders,
          signal: abortController.signal
        });
        console.warn(`[audio] retry result id=${videoId}: upstream ${upstreamRes.status}`);
      } else {
        console.warn(`[audio] retry aborted id=${videoId}: re-extraction failed`);
      }
    }

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      console.warn(`[audio] stream 502 id=${videoId}: upstream status ${upstreamRes.status}`);
      const reason = (upstreamRes.status === 403 || upstreamRes.status === 410) ? 'upstream-403' : 'upstream-error';
      res.status(502).json({ error: 'Audio upstream failed', reason });
      return;
    }

    res.status(upstreamRes.status);
    res.setHeader('Content-Type', format.mimeType || upstreamRes.headers.get('content-type') || 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    if (!upstreamRes.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body);
    nodeStream.on('error', () => {
      try { res.end(); } catch (e) {}
    });
    nodeStream.pipe(res);
  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.warn(`[audio] stream error id=${videoId}: ${e?.message || e}`);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Audio stream error', reason: 'server-error' });
    } else {
      try { res.end(); } catch (err) {}
    }
  }
}

export async function resolveAudioStream({ videoId }) {
  const format = await getYoutubeAudioFormat(videoId);
  if (format?.url) {
    return {
      mode: 'audio',
      url: `/api/audio/${encodeURIComponent(videoId)}`,
      source: 'ytdl-m4a-proxy'
    };
  }
  return { mode: 'iframe', url: null, source: 'yt-iframe' };
}
