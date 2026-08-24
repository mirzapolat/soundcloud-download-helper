// ==UserScript==
// @name         SoundCloud Downloader (with ID3 metadata)
// @namespace    https://github.com/mirzapolat/userscripts
// @homepageURL  https://github.com/mirzapolat/soundcloud-download-helper
// @downloadURL  https://raw.githubusercontent.com/mirzapolat/soundcloud-download-helper/main/soundcloud-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/mirzapolat/soundcloud-download-helper/main/soundcloud-downloader.user.js
// @version      1.6.0
// @description  Download SoundCloud tracks as MP3 with ID3v2 tags, metadata preview, cancel support, a batch download queue (ZIP) and a freely draggable button
// @author       mirzapolat
// @match        https://soundcloud.com/*
// @icon         https://a-v2.sndcdn.com/assets/images/sc-icons/favicon-48x48-8466dd3758.png
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      soundcloud.com
// @connect      sndcdn.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // Hard guard: never run twice in the same window (iframes are already
  // excluded via @noframes, this catches double-installs / re-injection).
  if (window.__SCDL_LOADED__) return;
  window.__SCDL_LOADED__ = true;

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */

  const CONFIG = {
    // Show the metadata preview before downloading. false = download instantly.
    preview: true,
    // Bundle queue downloads into a single .zip. false = save each file separately
    // (which makes the browser ask for every single file).
    bundleAsZip: true,
    // Split "Artist - Title" from the SoundCloud title into separate tags.
    splitArtistFromTitle: true,
    // Strip markers like [FREE DL], (Free Download), *FREE DOWNLOAD* from the title.
    cleanTitle: true,
    // Cover art size: t500x500 | t1080x1080 | original
    artworkSize: 't1080x1080',
    // Filename pattern. Available: {artist} {title} {user} {year} {genre}
    filename: '{artist} - {title}',
    // Name of the bundled archive. Available: {count} {date}
    zipName: 'SoundCloud {count} tracks {date}',
    // Also write the SoundCloud URL + description into the comment frame.
    commentWithDescription: true,
  };

  const API = 'https://api-v2.soundcloud.com';
  const QUEUE_KEY = 'download_queue';
  const POS_KEY = 'fab_position';

  // UI strings — edit freely.
  const T = {
    download: 'Download',
    downloadAll: 'Download all',
    addToQueue: '+ Queue',
    queue: 'Queue',
    cancel: 'Cancel',
    close: 'Close',
    clear: 'Clear',
    remove: 'Remove',
    nothingSelected: 'No track selected',
    openTrack: 'Click to open the track page',
    inline: 'Download',
    loading: 'Loading track info …',
    preparing: 'Preparing …',
    artwork: 'Fetching cover …',
    tagging: 'Writing tags …',
    downloading: 'Downloading …',
    zipping: 'Building archive …',
    saved: 'Saved',
    cancelled: 'Cancelled',
    failed: 'Failed',
    busy: 'A download is already running.',
    noTrack: 'Open a track page or start playing a song first.',
    untagged: 'Only AAC available → saved as .m4a without tags.',
    by: 'by',
    dragHint: 'Drag to move · double-click to reset · arrow keys to nudge',
    downloadTitle: (t) => `Download "${t}" · Alt+D · Alt+Q to queue`,
    queued: 'Added to queue',
    alreadyQueued: 'Already in the queue.',
    queueEmpty: 'The queue is empty. Use the + button next to any track.',
    emptyHint: 'Nothing queued yet.',
    resolving: 'Reading track …',
    trackOf: (i, n) => `Track ${i} of ${n}`,
    doneCount: (ok, failed) =>
      failed ? `${ok} saved, ${failed} failed` : `${ok} track${ok === 1 ? '' : 's'} saved`,
  };

  /* ------------------------------------------------------------------ *
   * Cancellation
   * ------------------------------------------------------------------ */

  class CancelledError extends Error {
    constructor() {
      super('cancelled');
      this.name = 'CancelledError';
    }
  }

  class CancelToken {
    constructor() {
      this.cancelled = false;
      this.handles = new Set();
    }
    track(handle) {
      if (!handle || typeof handle.abort !== 'function') return handle;
      if (this.cancelled) {
        try { handle.abort(); } catch (_) {}
      } else {
        this.handles.add(handle);
      }
      return handle;
    }
    release(handle) {
      this.handles.delete(handle);
    }
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const h of this.handles) {
        try { h.abort(); } catch (_) {}
      }
      this.handles.clear();
    }
    check() {
      if (this.cancelled) throw new CancelledError();
    }
  }

  const isCancel = (e) => e instanceof CancelledError || /cancel|abort/i.test((e && e.message) || '');

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function gmFetch(url, opts = {}) {
    const token = opts.token;
    if (token) token.check();

    return new Promise((resolve, reject) => {
      let handle;
      const done = (fn) => (arg) => {
        if (token && handle) token.release(handle);
        fn(arg);
      };
      handle = GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: opts.responseType || 'text',
        headers: opts.headers || {},
        onprogress: opts.onProgress
          ? (e) => opts.onProgress(e.loaded, e.lengthComputable ? e.total : 0)
          : undefined,
        onload: done((res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(opts.responseType === 'arraybuffer' ? res.response : res.responseText);
          } else {
            reject(new Error('HTTP ' + res.status + ' for ' + url));
          }
        }),
        onerror: done(() =>
          reject(token && token.cancelled ? new CancelledError() : new Error('Network error for ' + url))
        ),
        onabort: done(() => reject(new CancelledError())),
        ontimeout: done(() => reject(new Error('Timeout for ' + url))),
      });
      if (token) token.track(handle);
    });
  }

  const gmJSON = async (url, token) => JSON.parse(await gmFetch(url, { token }));

  function sanitize(name) {
    return name
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 180);
  }

  function formatDuration(ms) {
    if (!ms) return '–';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  const formatBytes = (n) =>
    n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  /* ------------------------------------------------------------------ *
   * client_id discovery
   * ------------------------------------------------------------------ */

  let clientIdCache = null;

  async function getClientId(force = false) {
    if (clientIdCache && !force) return clientIdCache;

    const stored = GM_getValue('client_id', '');
    if (stored && !force) {
      clientIdCache = stored;
      return stored;
    }

    const scripts = [...document.querySelectorAll('script[src]')]
      .map((s) => s.src)
      .filter((s) => /a-v2\.sndcdn\.com\/assets\/.*\.js/.test(s))
      .reverse();

    for (const src of scripts) {
      try {
        const js = await gmFetch(src);
        const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
        if (m) {
          clientIdCache = m[1];
          GM_setValue('client_id', clientIdCache);
          return clientIdCache;
        }
      } catch (_) {
        /* try the next bundle */
      }
    }
    throw new Error('No client_id found in the SoundCloud bundles.');
  }

  async function apiJSON(pathWithQuery, token) {
    const cid = await getClientId();
    const sep = pathWithQuery.includes('?') ? '&' : '?';
    try {
      return await gmJSON(`${API}${pathWithQuery}${sep}client_id=${cid}`, token);
    } catch (e) {
      if (isCancel(e) || !/HTTP 40[13]/.test(e.message)) throw e;
      const fresh = await getClientId(true);
      return gmJSON(`${API}${pathWithQuery}${sep}client_id=${fresh}`, token);
    }
  }

  /* ------------------------------------------------------------------ *
   * Track resolution
   * ------------------------------------------------------------------ */

  const RESERVED = new Set([
    'you', 'discover', 'stream', 'upload', 'search', 'settings', 'pages',
    'terms-of-use', 'imprint', 'people', 'charts', 'tags', 'popular',
    'notifications', 'messages', 'library', 'feed',
  ]);

  function trackUrlFromLocation() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    if (RESERVED.has(parts[0]) || parts[1] === 'sets' || parts[1] === 'albums') return null;
    return location.origin + '/' + parts[0] + '/' + parts[1];
  }

  function nowPlayingUrl() {
    const a = document.querySelector('.playbackSoundBadge__titleLink');
    return a ? a.href.split('?')[0] : null;
  }

  async function resolveTrack(permalinkUrl, token) {
    const data = await apiJSON('/resolve?url=' + encodeURIComponent(permalinkUrl), token);
    if (data.kind !== 'track') throw new Error('Not a single track (kind: ' + data.kind + ').');
    return data;
  }

  /* ------------------------------------------------------------------ *
   * Audio download
   * ------------------------------------------------------------------ */

  const PRESET_LABEL = {
    mp3_1_0: 'MP3 128 kbit/s',
    abr_sq: 'MP3 (ABR)',
    aac_160k: 'AAC 160 kbit/s',
    aac_96k: 'AAC 96 kbit/s',
  };

  function pickTranscoding(track) {
    const list = (track.media && track.media.transcodings) || [];
    const is = (t, proto, mime) =>
      t.format.protocol === proto && t.format.mime_type.startsWith(mime);

    return (
      list.find((t) => is(t, 'progressive', 'audio/mpeg')) ||
      list.find((t) => is(t, 'hls', 'audio/mpeg')) ||
      list.find((t) => t.format.protocol === 'hls' && t.preset === 'aac_160k') ||
      list.find((t) => t.format.protocol === 'hls') ||
      list[0] ||
      null
    );
  }

  async function transcodingMediaUrl(transcoding, trackAuthorization, token) {
    const cid = await getClientId();
    const sep = transcoding.url.includes('?') ? '&' : '?';
    const url = `${transcoding.url}${sep}client_id=${cid}&track_authorization=${encodeURIComponent(
      trackAuthorization || ''
    )}`;
    const res = JSON.parse(await gmFetch(url, { token }));
    if (!res.url) throw new Error('SoundCloud returned no media URL.');
    return res.url;
  }

  async function fetchProgressive(mediaUrl, token, onProgress) {
    const buf = await gmFetch(mediaUrl, {
      responseType: 'arraybuffer',
      token,
      onProgress: (loaded, total) =>
        onProgress(
          total ? loaded / total : null,
          total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded)
        ),
    });
    return new Uint8Array(buf);
  }

  async function fetchHls(playlistUrl, token, onProgress) {
    const playlist = await gmFetch(playlistUrl, { token });
    const base = playlistUrl.replace(/\/[^\/]*$/, '/');
    const segments = playlist
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => (/^https?:\/\//.test(l) ? l : base + l));

    if (!segments.length) throw new Error('Empty HLS playlist.');

    const parts = new Array(segments.length);
    const CONCURRENCY = 6;
    let done = 0;
    let next = 0;

    async function worker() {
      while (next < segments.length) {
        token.check();
        const i = next++;
        parts[i] = new Uint8Array(await gmFetch(segments[i], { responseType: 'arraybuffer', token }));
        done++;
        onProgress(done / segments.length, `${done} / ${segments.length} segments`);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));
    token.check();

    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * ID3v2.3 writer
   * ------------------------------------------------------------------ */

  function utf16le(str) {
    const out = new Uint8Array(2 + str.length * 2 + 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[2 + i * 2] = c & 0xff;
      out[3 + i * 2] = c >> 8;
    }
    return out; // trailing two zero bytes act as the UTF-16 terminator
  }

  const latin1 = (str) => Uint8Array.from([...str].map((c) => c.charCodeAt(0) & 0xff));

  function concatBytes(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function frame(id, bodyChunks) {
    const body = concatBytes(bodyChunks);
    const head = new Uint8Array(10);
    head.set(latin1(id), 0);
    head[4] = (body.length >>> 24) & 0xff;
    head[5] = (body.length >>> 16) & 0xff;
    head[6] = (body.length >>> 8) & 0xff;
    head[7] = body.length & 0xff;
    return concatBytes([head, body]);
  }

  const textFrame = (id, value) =>
    value ? frame(id, [Uint8Array.of(0x01), utf16le(String(value))]) : null;

  const commentFrame = (value) =>
    value
      ? frame('COMM', [Uint8Array.of(0x01), latin1('eng'), utf16le(''), utf16le(String(value))])
      : null;

  const urlFrame = (id, value) => (value ? frame(id, [latin1(String(value))]) : null);

  function pictureFrame(bytes, mime) {
    if (!bytes || !bytes.length) return null;
    return frame('APIC', [
      Uint8Array.of(0x00),
      latin1(mime || 'image/jpeg'),
      Uint8Array.of(0x00),
      Uint8Array.of(0x03), // front cover
      Uint8Array.of(0x00), // empty description
      bytes,
    ]);
  }

  function buildId3(meta, cover) {
    const frames = [
      textFrame('TIT2', meta.title),
      textFrame('TPE1', meta.artist),
      textFrame('TPE2', meta.albumArtist),
      textFrame('TALB', meta.album),
      textFrame('TCON', meta.genre),
      textFrame('TYER', meta.year),
      textFrame('TPUB', meta.publisher),
      textFrame('TSRC', meta.isrc),
      textFrame('TCOM', meta.composer),
      commentFrame(meta.comment),
      urlFrame('WOAF', meta.url),
      urlFrame('WOAR', meta.artistUrl),
      pictureFrame(cover && cover.bytes, cover && cover.mime),
    ].filter(Boolean);

    const body = concatBytes(frames);
    const header = new Uint8Array(10);
    header.set(latin1('ID3'), 0);
    header[3] = 3; // v2.3
    const n = body.length;
    header[6] = (n >>> 21) & 0x7f;
    header[7] = (n >>> 14) & 0x7f;
    header[8] = (n >>> 7) & 0x7f;
    header[9] = n & 0x7f;

    return concatBytes([header, body]);
  }

  function stripExistingId3(bytes) {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes;
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const footer = bytes[5] & 0x10 ? 10 : 0;
    return bytes.subarray(10 + size + footer);
  }

  /* ------------------------------------------------------------------ *
   * ZIP writer (store method — audio is already compressed)
   * ------------------------------------------------------------------ */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  function uniqueName(name, used) {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 2;
    let candidate;
    do {
      candidate = `${base} (${i++})${ext}`;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  }

  function buildZip(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const data = file.bytes;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // local file header signature
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0x0800, true); // flags: UTF-8 filenames (EFS)
      lv.setUint16(8, 0, true); // method: store
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // compressed size
      lv.setUint32(22, data.length, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra length
      local.set(nameBytes, 30);

      chunks.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); // central directory signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra
      cv.setUint16(32, 0, true); // comment
      cv.setUint16(34, 0, true); // disk number
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, offset, true); // relative offset of local header
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...chunks, ...central, eocd], { type: 'application/zip' });
  }

  /* ------------------------------------------------------------------ *
   * Metadata assembly
   * ------------------------------------------------------------------ */

  const FREE_DL_RE =
    /\s*[\[\(\{*|]+\s*(free\s*(dl|d\/l|download)?|f?d\s*l|out\s+now|buy\s*link|click\s+buy)\b[^\]\)\}*|]*[\]\)\}*|]*\s*$/gi;

  function parseMeta(track) {
    const pm = track.publisher_metadata || {};
    let title = (track.title || '').trim();
    let artist = '';

    if (CONFIG.splitArtistFromTitle) {
      const m = title.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
      if (m) {
        artist = m[1].trim();
        title = m[2].trim();
      }
    }
    if (!artist) artist = (pm.artist || track.user.username || '').trim();

    if (CONFIG.cleanTitle) {
      title = title.replace(FREE_DL_RE, '').trim() || track.title;
    }

    const date = track.release_date || track.display_date || track.created_at || '';
    const year = date ? String(date).slice(0, 4) : '';

    const comment = CONFIG.commentWithDescription
      ? [track.permalink_url, track.description || ''].filter(Boolean).join('\n\n')
      : track.permalink_url;

    return {
      title,
      artist,
      albumArtist: track.user.username,
      album: (track.label_name || '').trim() || undefined,
      genre: track.genre || undefined,
      year,
      publisher: (track.label_name || '').trim() || undefined,
      isrc: pm.isrc || undefined,
      composer: pm.writer_composer || undefined,
      comment,
      url: track.permalink_url,
      artistUrl: track.user.permalink_url,
      duration: track.full_duration || track.duration || 0,
    };
  }

  const artworkUrl = (track, size) => {
    const raw = track.artwork_url || (track.user && track.user.avatar_url);
    return raw ? raw.replace(/-(large|t\d+x\d+|original)\.(jpg|png)/, `-${size}.$2`) : null;
  };

  async function fetchCover(track, token) {
    const url = artworkUrl(track, CONFIG.artworkSize);
    if (!url) return null;
    try {
      const buf = await gmFetch(url, { responseType: 'arraybuffer', token });
      return { bytes: new Uint8Array(buf), mime: url.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    } catch (e) {
      if (isCancel(e)) throw e;
      return null;
    }
  }

  function buildFilename(meta, ext) {
    const name = CONFIG.filename
      .replace('{artist}', meta.artist || '')
      .replace('{title}', meta.title || '')
      .replace('{user}', meta.albumArtist || '')
      .replace('{year}', meta.year || '')
      .replace('{genre}', meta.genre || '')
      .replace(/^\s*-\s*/, '');
    return sanitize(name || meta.title || 'track') + ext;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ------------------------------------------------------------------ *
   * Shared track pipeline
   * ------------------------------------------------------------------ */

  // Resolves + downloads + tags one track. Returns { meta, filename, bytes, isMp3 }.
  async function prepareTrack(track, token, onStage) {
    const meta = parseMeta(track);
    const transcoding = pickTranscoding(track);
    if (!transcoding) throw new Error('No playable stream found for this track.');

    const isMp3 = transcoding.format.mime_type.startsWith('audio/mpeg');
    const ext = isMp3 ? '.mp3' : '.m4a';

    const mediaUrl = await transcodingMediaUrl(transcoding, track.track_authorization, token);
    token.check();

    const audio =
      transcoding.format.protocol === 'progressive'
        ? await fetchProgressive(mediaUrl, token, (f, l) => onStage('progress', f, l))
        : await fetchHls(mediaUrl, token, (f, l) => onStage('progress', f, l));
    token.check();

    let bytes;
    if (isMp3) {
      onStage('artwork');
      const cover = await fetchCover(track, token);
      token.check();
      onStage('tagging');
      bytes = concatBytes([buildId3(meta, cover), stripExistingId3(audio)]);
    } else {
      bytes = audio;
    }
    token.check();

    return { meta, filename: buildFilename(meta, ext), bytes, isMp3 };
  }

  /* ------------------------------------------------------------------ *
   * Queue storage
   * ------------------------------------------------------------------ */

  function getQueue() {
    try {
      const raw = GM_getValue(QUEUE_KEY, '[]');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function setQueue(list) {
    GM_setValue(QUEUE_KEY, JSON.stringify(list));
    updateQueueBadge();
  }

  const inQueue = (url) => getQueue().some((i) => i.url === url);

  function removeFromQueue(url) {
    setQueue(getQueue().filter((i) => i.url !== url));
  }

  async function addToQueue(permalinkUrl) {
    if (inQueue(permalinkUrl)) {
      toast(T.alreadyQueued);
      return;
    }
    const token = new CancelToken();
    try {
      toast(T.resolving, 8000);
      const track = await resolveTrack(permalinkUrl, token);
      const meta = parseMeta(track);
      const list = getQueue();
      if (list.some((i) => i.url === track.permalink_url)) {
        toast(T.alreadyQueued);
        return;
      }
      list.push({
        url: track.permalink_url,
        title: meta.title,
        artist: meta.artist,
        duration: meta.duration,
        artwork: artworkUrl(track, 't50x50') || '',
        addedAt: Date.now(),
      });
      setQueue(list);
      toast(`${T.queued}: ${meta.artist} – ${meta.title}`);
    } catch (e) {
      if (isCancel(e)) return;
      console.error('[SC-DL]', e);
      toast(`${T.failed}: ${e.message}`, 5000);
    }
  }

  /* ------------------------------------------------------------------ *
   * Styles
   * ------------------------------------------------------------------ */

  GM_addStyle(`
    /* ---- liquid glass tokens ---- */
    .scdl-fabs {
      position: fixed; right: 18px; bottom: 90px; z-index: 2147483000;
      display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
      transition: left .22s cubic-bezier(.2,.85,.3,1), top .22s cubic-bezier(.2,.85,.3,1);
      --g-fill: linear-gradient(145deg, rgba(255,255,255,.17), rgba(255,255,255,.05) 55%, rgba(255,255,255,.10));
      --g-edge: rgba(255,255,255,.22);
      --g-drop: 0 10px 34px rgba(0,0,0,.42), 0 2px 8px rgba(0,0,0,.26);
      --g-inner: inset 0 1px 0 rgba(255,255,255,.30), inset 0 -1px 0 rgba(255,255,255,.07);
      --g-blur: blur(22px) saturate(185%);
    }
    .scdl-fabs.scdl-anchor-left { align-items: flex-start; }
    .scdl-fabs.scdl-dragging { transition: none; filter: drop-shadow(0 14px 30px rgba(0,0,0,.45)); }
    /* Swallow clicks on the buttons while dragging. */
    .scdl-fabs.scdl-dragging .scdl-fab,
    .scdl-fabs.scdl-dragging .scdl-fab-dl { pointer-events: none; }

    /* Frosted pane + specular sheen. ::before paints above the background but
       below the text, so content stays legible. */
    .scdl-glass {
      position: relative;
      background: var(--g-fill);
      -webkit-backdrop-filter: var(--g-blur);
      backdrop-filter: var(--g-blur);
      border: 1px solid var(--g-edge);
      box-shadow: var(--g-drop), var(--g-inner);
    }
    .scdl-glass::before {
      content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
      background: radial-gradient(135% 95% at 26% -12%, rgba(255,255,255,.40), rgba(255,255,255,0) 58%);
      opacity: .8;
    }

    /* ---- drag grip ---- */
    .scdl-grip {
      display: grid; grid-template-columns: repeat(3, 3px); gap: 3px;
      justify-content: center; align-content: center;
      width: 40px; height: 20px; padding: 0; margin-bottom: -3px;
      border-radius: 10px; cursor: grab; touch-action: none;
      -webkit-user-select: none; user-select: none;
      opacity: 0; transform: translateY(6px) scale(.94);
      transition: opacity .2s ease, transform .2s cubic-bezier(.2,.85,.3,1),
                  background .16s ease, border-color .16s ease;
    }
    .scdl-grip > i { width: 3px; height: 3px; border-radius: 50%; background: rgba(255,255,255,.6); transition: background .16s; }
    .scdl-fabs:hover .scdl-grip,
    .scdl-fabs:focus-within .scdl-grip,
    .scdl-fabs.scdl-dragging .scdl-grip { opacity: 1; transform: none; }
    .scdl-grip:hover, .scdl-grip:focus-visible,
    .scdl-fabs.scdl-dragging .scdl-grip {
      background: linear-gradient(145deg, rgba(255,120,50,.85), rgba(255,68,0,.7));
      border-color: rgba(255,140,80,.6); outline: none;
    }
    .scdl-grip:hover > i, .scdl-grip:focus-visible > i,
    .scdl-fabs.scdl-dragging .scdl-grip > i { background: #fff; }
    .scdl-fabs.scdl-dragging .scdl-grip { cursor: grabbing; }

    /* ---- queue pill ---- */
    .scdl-fab {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 14px; border-radius: 999px;
      color: #fff; font: 600 12.5px/1 Inter, system-ui, sans-serif;
      cursor: pointer;
      transition: transform .22s cubic-bezier(.2,.85,.3,1), background .16s ease, border-color .16s ease;
    }
    .scdl-fab:hover { background: linear-gradient(145deg, rgba(255,255,255,.26), rgba(255,255,255,.10)); }
    .scdl-fab-queue { flex: 0 0 auto; }
    .scdl-fab-queue[hidden] { display: none; }
    .scdl-badge {
      background: linear-gradient(145deg, #ff7a3c, #f50); color: #fff;
      border-radius: 999px; padding: 1px 7px; font-size: 11px; font-weight: 700;
      box-shadow: 0 1px 4px rgba(255,85,0,.5);
    }

    /* ---- bubble + round download button ---- */
    .scdl-dock { display: flex; align-items: center; gap: 10px; }
    .scdl-fabs.scdl-anchor-left .scdl-dock { flex-direction: row-reverse; }

    .scdl-now {
      display: flex; align-items: center; gap: 9px;
      max-width: 190px; padding: 6px 14px 6px 6px; border-radius: 999px;
      overflow: hidden; -webkit-user-select: none; user-select: none;
      text-decoration: none; color: inherit; cursor: default;
      transition: transform .22s cubic-bezier(.2,.85,.3,1), background .16s ease, border-color .16s ease;
    }
    .scdl-now[href] { cursor: pointer; }
    .scdl-now[href]:hover {
      background: linear-gradient(145deg, rgba(255,255,255,.26), rgba(255,255,255,.10));
      border-color: rgba(255,255,255,.32); transform: translateY(-1px);
    }
    .scdl-now[href]:active { transform: scale(.985); }
    .scdl-now[href]:focus-visible { outline: 2px solid rgba(255,140,80,.8); outline-offset: 2px; }
    .scdl-now[href]:hover .scdl-now-art { transform: scale(1.06); }
    .scdl-now-art { transition: transform .22s cubic-bezier(.2,.85,.3,1); }
    .scdl-now-art {
      width: 32px; height: 32px; flex: 0 0 32px; border-radius: 50%;
      background: rgba(255,255,255,.14) center/cover no-repeat;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.22), 0 1px 3px rgba(0,0,0,.3);
    }
    .scdl-now-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .scdl-now-title {
      font: 600 12px/1.3 Inter, system-ui, sans-serif; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .scdl-now-artist {
      font: 400 11px/1.2 Inter, system-ui, sans-serif; color: rgba(255,255,255,.62);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .scdl-now-empty .scdl-now-title { color: rgba(255,255,255,.5); font-weight: 500; }
    .scdl-now-empty .scdl-now-art { opacity: .45; }
    @keyframes scdl-swap { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
    .scdl-now.scdl-swap .scdl-now-text { animation: scdl-swap .3s cubic-bezier(.2,.85,.3,1); }

    .scdl-fab-dl {
      width: 52px; height: 52px; flex: 0 0 52px; padding: 0;
      display: grid; place-items: center; border-radius: 50%;
      color: #fff; cursor: pointer;
      background: linear-gradient(150deg, rgba(255,124,56,.95), rgba(255,68,0,.82));
      border: 1px solid rgba(255,150,100,.5);
      box-shadow: var(--g-drop), inset 0 1px 0 rgba(255,255,255,.38), 0 0 22px rgba(255,85,0,.28);
      -webkit-backdrop-filter: var(--g-blur); backdrop-filter: var(--g-blur);
      transition: transform .22s cubic-bezier(.2,.85,.3,1), box-shadow .2s ease,
                  background .2s ease, border-color .2s ease, opacity .2s ease;
    }
    .scdl-fab-dl:hover:not(:disabled) {
      transform: translateY(-1px) scale(1.05);
      box-shadow: var(--g-drop), inset 0 1px 0 rgba(255,255,255,.45), 0 0 30px rgba(255,85,0,.45);
    }
    .scdl-fab-dl:active:not(:disabled) { transform: scale(.96); }
    .scdl-fab-dl svg { width: 21px; height: 21px; position: relative; }
    .scdl-fab-dl:disabled {
      cursor: default;
      background: linear-gradient(150deg, rgba(255,255,255,.13), rgba(255,255,255,.05));
      border-color: rgba(255,255,255,.16);
      color: rgba(255,255,255,.34);
      box-shadow: 0 6px 18px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.16);
    }

    .scdl-inline { margin-left: 4px !important; }
    .scdl-inline-add { margin-left: 2px !important; min-width: 0 !important; padding: 0 8px !important; }

    .scdl-overlay {
      position: fixed; inset: 0; z-index: 2147483100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.55); backdrop-filter: blur(2px);
      font: 400 14px/1.45 Inter, system-ui, sans-serif;
    }
    .scdl-modal {
      width: min(440px, calc(100vw - 32px));
      background: #1c1c1c; color: #eee; border-radius: 12px;
      box-shadow: 0 18px 48px rgba(0,0,0,.55);
      overflow: hidden; border: 1px solid #333;
    }
    .scdl-modal-wide { width: min(520px, calc(100vw - 32px)); }
    .scdl-head { display: flex; gap: 14px; padding: 18px; }
    .scdl-art {
      width: 96px; height: 96px; flex: 0 0 96px; border-radius: 6px;
      object-fit: cover; background: #333;
    }
    .scdl-info { min-width: 0; flex: 1; }
    .scdl-title {
      font-size: 16px; font-weight: 700; color: #fff; margin: 0 0 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scdl-artist {
      color: #ccc; margin: 0 0 8px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scdl-facts { display: flex; flex-wrap: wrap; gap: 4px 6px; }
    .scdl-chip {
      background: #2c2c2c; color: #bbb; border-radius: 4px;
      padding: 2px 7px; font-size: 11.5px; white-space: nowrap;
    }
    .scdl-file {
      padding: 0 18px 4px; color: #888; font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scdl-file b { color: #aaa; font-weight: 500; }
    .scdl-warn { padding: 0 18px 10px; color: #ffb057; font-size: 12px; }
    .scdl-status { padding: 4px 18px 0; color: #bbb; font-size: 12.5px; min-height: 18px; }
    .scdl-bar { height: 4px; background: #2c2c2c; margin: 10px 18px 0; border-radius: 2px; overflow: hidden; }
    .scdl-bar > i { display: block; height: 100%; width: 0; background: #f50; transition: width .15s linear; }
    .scdl-bar.scdl-indeterminate > i { width: 40%; animation: scdl-slide 1.1s ease-in-out infinite; }
    @keyframes scdl-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
    .scdl-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 18px 18px; }
    .scdl-actions .scdl-spacer { margin-right: auto; }
    .scdl-btn {
      border: 0; border-radius: 6px; padding: 9px 16px; cursor: pointer;
      font: 600 13px/1 Inter, system-ui, sans-serif;
    }
    .scdl-btn-primary { background: #f50; color: #fff; }
    .scdl-btn-primary:hover { background: #ff6a1f; }
    .scdl-btn-primary:disabled { background: #5a3520; color: #bbb; cursor: default; }
    .scdl-btn-ghost { background: #333; color: #ddd; }
    .scdl-btn-ghost:hover { background: #3d3d3d; }
    .scdl-btn:disabled { opacity: .55; cursor: default; }
    .scdl-err { color: #ff7a6b; }
    .scdl-ok { color: #6bd08a; }

    .scdl-qhead {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 16px 18px 10px; border-bottom: 1px solid #2c2c2c;
    }
    .scdl-qhead h2 { margin: 0; font-size: 15px; color: #fff; font-weight: 700; }
    .scdl-qhead span { color: #888; font-size: 12px; }
    .scdl-list { max-height: min(50vh, 380px); overflow-y: auto; }
    .scdl-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 18px; border-bottom: 1px solid #262626;
    }
    .scdl-row:last-child { border-bottom: 0; }
    .scdl-row img { width: 36px; height: 36px; border-radius: 4px; object-fit: cover; background: #333; flex: 0 0 36px; }
    .scdl-row-info { min-width: 0; flex: 1; }
    .scdl-row-title { color: #eee; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scdl-row-sub { color: #888; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scdl-row-state { font-size: 11.5px; color: #888; white-space: nowrap; }
    .scdl-row-x {
      background: none; border: 0; color: #777; cursor: pointer;
      font-size: 17px; line-height: 1; padding: 4px 6px;
    }
    .scdl-row-x:hover { color: #ff7a6b; }
    .scdl-empty { padding: 26px 18px; text-align: center; color: #777; font-size: 13px; }

    .scdl-toast {
      position: fixed; right: 18px; bottom: 150px; z-index: 2147483200;
      max-width: 320px; padding: 10px 14px; border-radius: 8px;
      background: #222; color: #fff; font: 400 13px/1.4 Inter, system-ui, sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
    }
  `);

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */

  let toastEl = null;
  let toastTimer = null;

  function toast(msg, timeout = 3500) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'scdl-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl && toastEl.remove();
      toastEl = null;
    }, timeout);
  }

  /* ------------------------------------------------------------------ *
   * Preview / progress modal
   * ------------------------------------------------------------------ */

  function openModal(onEscape) {
    const overlay = document.createElement('div');
    overlay.className = 'scdl-overlay';
    overlay.innerHTML = `
      <div class="scdl-modal" role="dialog" aria-modal="true">
        <div class="scdl-head">
          <img class="scdl-art" alt="">
          <div class="scdl-info">
            <p class="scdl-title">${escapeHtml(T.loading)}</p>
            <p class="scdl-artist"></p>
            <div class="scdl-facts"></div>
          </div>
        </div>
        <div class="scdl-file"></div>
        <div class="scdl-warn" hidden></div>
        <div class="scdl-bar scdl-indeterminate"><i></i></div>
        <div class="scdl-status"></div>
        <div class="scdl-actions">
          <button class="scdl-btn scdl-btn-ghost" data-act="cancel">${escapeHtml(T.cancel)}</button>
          <button class="scdl-btn scdl-btn-ghost" data-act="queue" hidden>${escapeHtml(T.addToQueue)}</button>
          <button class="scdl-btn scdl-btn-primary" data-act="ok" hidden>${escapeHtml(T.download)}</button>
        </div>
      </div>`;

    const q = (sel) => overlay.querySelector(sel);
    const api = {
      overlay,
      art: q('.scdl-art'),
      title: q('.scdl-title'),
      artist: q('.scdl-artist'),
      facts: q('.scdl-facts'),
      file: q('.scdl-file'),
      warn: q('.scdl-warn'),
      bar: q('.scdl-bar'),
      fill: q('.scdl-bar > i'),
      status: q('.scdl-status'),
      okBtn: q('[data-act="ok"]'),
      queueBtn: q('[data-act="queue"]'),
      cancelBtn: q('[data-act="cancel"]'),
      setStatus(msg, cls) {
        api.status.className = 'scdl-status' + (cls ? ' ' + cls : '');
        api.status.textContent = msg || '';
      },
      setProgress(fraction) {
        if (fraction == null) {
          api.bar.classList.add('scdl-indeterminate');
          api.fill.style.width = '';
        } else {
          api.bar.classList.remove('scdl-indeterminate');
          api.fill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
        }
      },
      close() {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
      },
    };

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) onEscape();
    });

    document.body.appendChild(overlay);
    return api;
  }

  function renderPreview(ui, track, meta, transcoding, ext) {
    const art = artworkUrl(track, 't500x500');
    if (art) ui.art.src = art;

    ui.title.textContent = meta.title;
    ui.artist.textContent = `${T.by} ${meta.artist}`;

    const facts = [
      formatDuration(meta.duration),
      meta.genre,
      meta.year,
      transcoding ? PRESET_LABEL[transcoding.preset] || transcoding.preset : null,
      meta.albumArtist !== meta.artist ? '@' + track.user.permalink : null,
      meta.isrc ? 'ISRC ' + meta.isrc : null,
    ].filter(Boolean);

    ui.facts.innerHTML = facts.map((f) => `<span class="scdl-chip">${escapeHtml(f)}</span>`).join('');
    ui.file.innerHTML = `<b>${escapeHtml(buildFilename(meta, ext))}</b>`;

    ui.warn.hidden = ext === '.mp3';
    if (ext !== '.mp3') ui.warn.textContent = T.untagged;
  }

  /* ------------------------------------------------------------------ *
   * Single download
   * ------------------------------------------------------------------ */

  let activeToken = null;

  async function requestDownload(permalinkUrl) {
    if (activeToken) {
      toast(T.busy);
      return;
    }

    const token = new CancelToken();
    activeToken = token;
    const finish = () => {
      if (activeToken === token) activeToken = null;
    };

    const ui = openModal(() => token.cancel());
    ui.cancelBtn.addEventListener('click', () => {
      token.cancel();
      ui.close();
      finish();
    });

    try {
      ui.setStatus(T.loading);
      ui.setProgress(null);

      const track = await resolveTrack(permalinkUrl, token);
      token.check();

      const meta = parseMeta(track);
      const transcoding = pickTranscoding(track);
      if (!transcoding) throw new Error('No playable stream found for this track.');
      const ext = transcoding.format.mime_type.startsWith('audio/mpeg') ? '.mp3' : '.m4a';

      renderPreview(ui, track, meta, transcoding, ext);
      ui.setStatus('');
      ui.setProgress(0);

      if (CONFIG.preview) {
        ui.okBtn.hidden = false;
        ui.queueBtn.hidden = inQueue(track.permalink_url);

        const choice = await new Promise((resolve, reject) => {
          const iv = setInterval(() => {
            if (token.cancelled) {
              clearInterval(iv);
              reject(new CancelledError());
            }
          }, 120);
          const pick = (what) => () => {
            clearInterval(iv);
            resolve(what);
          };
          ui.okBtn.addEventListener('click', pick('download'), { once: true });
          ui.queueBtn.addEventListener('click', pick('queue'), { once: true });
        });

        if (choice === 'queue') {
          const list = getQueue();
          list.push({
            url: track.permalink_url,
            title: meta.title,
            artist: meta.artist,
            duration: meta.duration,
            artwork: artworkUrl(track, 't50x50') || '',
            addedAt: Date.now(),
          });
          setQueue(list);
          ui.close();
          finish();
          toast(`${T.queued}: ${meta.artist} – ${meta.title}`);
          return;
        }

        ui.okBtn.disabled = true;
        ui.queueBtn.hidden = true;
        ui.okBtn.textContent = T.downloading;
      }

      token.check();
      ui.setStatus(T.preparing);
      ui.setProgress(null);

      const { bytes, filename, isMp3 } = await prepareTrack(track, token, (stage, fraction, label) => {
        if (stage === 'progress') {
          ui.setProgress(fraction);
          ui.setStatus(label || T.downloading);
        } else if (stage === 'artwork') {
          ui.setProgress(null);
          ui.setStatus(T.artwork);
        } else if (stage === 'tagging') {
          ui.setStatus(T.tagging);
        }
      });

      saveBlob(new Blob([bytes], { type: isMp3 ? 'audio/mpeg' : 'audio/mp4' }), filename);

      ui.setProgress(1);
      ui.setStatus(`${T.saved} · ${formatBytes(bytes.length)}`, 'scdl-ok');
      ui.okBtn.hidden = true;
      ui.cancelBtn.textContent = T.close;
      finish();
      setTimeout(() => ui.close(), 1800);
    } catch (err) {
      finish();
      if (isCancel(err)) {
        ui.close();
        toast(T.cancelled, 2000);
        return;
      }
      console.error('[SC-DL]', err);
      ui.setProgress(0);
      ui.setStatus(`${T.failed}: ${err.message}`, 'scdl-err');
      ui.okBtn.hidden = true;
      ui.queueBtn.hidden = true;
      ui.cancelBtn.textContent = T.close;
    }
  }

  /* ------------------------------------------------------------------ *
   * Queue panel + batch download
   * ------------------------------------------------------------------ */

  function openQueuePanel() {
    const overlay = document.createElement('div');
    overlay.className = 'scdl-overlay';
    overlay.innerHTML = `
      <div class="scdl-modal scdl-modal-wide" role="dialog" aria-modal="true">
        <div class="scdl-qhead">
          <h2>${escapeHtml(T.queue)}</h2>
          <span class="scdl-qcount"></span>
        </div>
        <div class="scdl-list"></div>
        <div class="scdl-bar" hidden><i></i></div>
        <div class="scdl-status"></div>
        <div class="scdl-actions">
          <button class="scdl-btn scdl-btn-ghost scdl-spacer" data-act="clear">${escapeHtml(T.clear)}</button>
          <button class="scdl-btn scdl-btn-ghost" data-act="close">${escapeHtml(T.close)}</button>
          <button class="scdl-btn scdl-btn-primary" data-act="all">${escapeHtml(T.downloadAll)}</button>
        </div>
      </div>`;

    const list = overlay.querySelector('.scdl-list');
    const count = overlay.querySelector('.scdl-qcount');
    const status = overlay.querySelector('.scdl-status');
    const bar = overlay.querySelector('.scdl-bar');
    const fill = overlay.querySelector('.scdl-bar > i');
    const allBtn = overlay.querySelector('[data-act="all"]');
    const clearBtn = overlay.querySelector('[data-act="clear"]');
    const closeBtn = overlay.querySelector('[data-act="close"]');

    let running = null; // CancelToken while a batch is in flight

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (running) running.cancel();
      else close();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target !== overlay) return;
      if (running) running.cancel();
      else close();
    });

    function render() {
      const items = getQueue();
      count.textContent = items.length
        ? `${items.length} track${items.length === 1 ? '' : 's'}`
        : '';
      allBtn.disabled = !items.length || !!running;
      clearBtn.disabled = !items.length || !!running;

      if (!items.length) {
        list.innerHTML = `<div class="scdl-empty">${escapeHtml(T.emptyHint)}</div>`;
        return;
      }

      list.innerHTML = items
        .map(
          (it) => `
        <div class="scdl-row" data-url="${escapeHtml(it.url)}">
          <img src="${escapeHtml(it.artwork)}" alt="">
          <div class="scdl-row-info">
            <div class="scdl-row-title">${escapeHtml(it.title)}</div>
            <div class="scdl-row-sub">${escapeHtml(it.artist)} · ${escapeHtml(formatDuration(it.duration))}</div>
          </div>
          <div class="scdl-row-state"></div>
          <button class="scdl-row-x" title="${escapeHtml(T.remove)}">×</button>
        </div>`
        )
        .join('');

      list.querySelectorAll('.scdl-row-x').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (running) return;
          removeFromQueue(btn.closest('.scdl-row').dataset.url);
          render();
        });
      });
    }

    const rowState = (url, text, cls) => {
      const el = list.querySelector(`.scdl-row[data-url="${CSS.escape(url)}"] .scdl-row-state`);
      if (el) {
        el.textContent = text;
        el.className = 'scdl-row-state' + (cls ? ' ' + cls : '');
      }
    };

    clearBtn.addEventListener('click', () => {
      if (running) return;
      setQueue([]);
      render();
    });

    closeBtn.addEventListener('click', () => {
      if (running) running.cancel();
      close();
    });

    allBtn.addEventListener('click', async () => {
      if (running || activeToken) {
        if (activeToken) toast(T.busy);
        return;
      }
      const items = getQueue();
      if (!items.length) {
        toast(T.queueEmpty, 4000);
        return;
      }

      const token = new CancelToken();
      running = token;
      activeToken = token;
      allBtn.disabled = true;
      clearBtn.disabled = true;
      list.querySelectorAll('.scdl-row-x').forEach((b) => (b.disabled = true));
      bar.hidden = false;

      const files = [];
      const done = [];
      const failed = [];

      const setBar = (f) => {
        if (f == null) {
          bar.classList.add('scdl-indeterminate');
          fill.style.width = '';
        } else {
          bar.classList.remove('scdl-indeterminate');
          fill.style.width = Math.max(0, Math.min(1, f)) * 100 + '%';
        }
      };

      try {
        for (let i = 0; i < items.length; i++) {
          token.check();
          const item = items[i];
          status.className = 'scdl-status';
          status.textContent = `${T.trackOf(i + 1, items.length)} — ${item.title}`;
          rowState(item.url, T.resolving);

          try {
            const track = await resolveTrack(item.url, token);
            token.check();
            const res = await prepareTrack(track, token, (stage, fraction, label) => {
              // Overall progress = finished tracks + progress within the current one.
              const within = stage === 'progress' && fraction != null ? fraction : 0;
              setBar((i + within) / items.length);
              if (stage === 'progress') rowState(item.url, label || T.downloading);
              else if (stage === 'artwork') rowState(item.url, T.artwork);
              else if (stage === 'tagging') rowState(item.url, T.tagging);
            });

            files.push({ name: res.filename, bytes: res.bytes, isMp3: res.isMp3 });
            done.push(item.url);
            rowState(item.url, `✓ ${formatBytes(res.bytes.length)}`, 'scdl-ok');
          } catch (e) {
            if (isCancel(e)) throw e;
            console.error('[SC-DL]', item.url, e);
            failed.push(item.url);
            rowState(item.url, '✕ ' + e.message.slice(0, 40), 'scdl-err');
          }
          setBar((i + 1) / items.length);
        }

        token.check();

        if (files.length) {
          if (CONFIG.bundleAsZip) {
            status.textContent = T.zipping;
            setBar(null);
            const used = new Set();
            const zip = buildZip(files.map((f) => ({ name: uniqueName(f.name, used), bytes: f.bytes })));
            const name =
              sanitize(
                CONFIG.zipName
                  .replace('{count}', files.length)
                  .replace('{date}', new Date().toISOString().slice(0, 10))
              ) + '.zip';
            saveBlob(zip, name);
            setBar(1);
          } else {
            for (const f of files) {
              saveBlob(new Blob([f.bytes], { type: f.isMp3 ? 'audio/mpeg' : 'audio/mp4' }), f.name);
              await new Promise((r) => setTimeout(r, 350)); // let the browser keep up
            }
          }
        }

        // Successfully downloaded tracks leave the queue, failures stay for a retry.
        setQueue(getQueue().filter((it) => !done.includes(it.url)));

        status.className = 'scdl-status ' + (failed.length ? 'scdl-err' : 'scdl-ok');
        status.textContent = T.doneCount(done.length, failed.length);
        closeBtn.textContent = T.close;
      } catch (e) {
        if (isCancel(e)) {
          status.className = 'scdl-status';
          status.textContent = T.cancelled;
        } else {
          console.error('[SC-DL]', e);
          status.className = 'scdl-status scdl-err';
          status.textContent = `${T.failed}: ${e.message}`;
        }
      } finally {
        running = null;
        if (activeToken === token) activeToken = null;
        bar.hidden = true;
        render();
      }
    });

    document.body.appendChild(overlay);
    render();
  }

  /* ------------------------------------------------------------------ *
   * UI injection
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * Draggable button stack
   * ------------------------------------------------------------------ */

  const FAB_MARGIN = 18; // resting distance from a snapped edge
  const FAB_SNAP = 28; // snap if dropped this close to an edge
  const FAB_EDGE = 4; // never allow it fully off-screen

  function loadFabPos() {
    try {
      const p = JSON.parse(GM_getValue(POS_KEY, 'null'));
      return p && Number.isFinite(p.left) && Number.isFinite(p.top) ? p : null;
    } catch (_) {
      return null;
    }
  }

  const saveFabPos = (p) => GM_setValue(POS_KEY, JSON.stringify(p));
  const clearFabPos = () => GM_setValue(POS_KEY, 'null');

  function clampFabPos(left, top, w, h, vw, vh) {
    return {
      left: Math.min(Math.max(FAB_EDGE, left), Math.max(FAB_EDGE, vw - w - FAB_EDGE)),
      top: Math.min(Math.max(FAB_EDGE, top), Math.max(FAB_EDGE, vh - h - FAB_EDGE)),
    };
  }

  // Dropping near an edge snaps to a clean margin instead of leaving a stray gap.
  function snapFabPos(left, top, w, h, vw, vh) {
    let l = left;
    let t = top;
    if (l <= FAB_SNAP) l = FAB_MARGIN;
    else if (vw - (l + w) <= FAB_SNAP) l = vw - w - FAB_MARGIN;
    if (t <= FAB_SNAP) t = FAB_MARGIN;
    else if (vh - (t + h) <= FAB_SNAP) t = vh - h - FAB_MARGIN;
    return clampFabPos(l, t, w, h, vw, vh);
  }

  function applyFabPos(wrap, pos) {
    if (!pos) {
      // Back to the CSS default (bottom right).
      wrap.style.left = wrap.style.top = wrap.style.right = wrap.style.bottom = '';
      wrap.classList.remove('scdl-anchor-left');
      return;
    }
    const c = clampFabPos(pos.left, pos.top, wrap.offsetWidth, wrap.offsetHeight,
                          window.innerWidth, window.innerHeight);
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    wrap.style.left = c.left + 'px';
    wrap.style.top = c.top + 'px';
    // Buttons hug the nearer side so the stack never reads as lopsided.
    wrap.classList.toggle('scdl-anchor-left', c.left + wrap.offsetWidth / 2 < window.innerWidth / 2);
    return c;
  }

  function makeFabDraggable(wrap, grip) {
    let offX = 0, offY = 0, startX = 0, startY = 0, moved = false;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      startX = e.clientX;
      startY = e.clientY;
      moved = false;
      // Pin the current visual spot as left/top before switching anchors,
      // otherwise the stack jumps on the first move.
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
      wrap.style.left = rect.left + 'px';
      wrap.style.top = rect.top + 'px';
      wrap.classList.add('scdl-dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    });

    grip.addEventListener('pointermove', (e) => {
      if (!wrap.classList.contains('scdl-dragging')) return;
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 3) moved = true;
      const c = clampFabPos(e.clientX - offX, e.clientY - offY, wrap.offsetWidth, wrap.offsetHeight,
                            window.innerWidth, window.innerHeight);
      wrap.style.left = c.left + 'px';
      wrap.style.top = c.top + 'px';
      wrap.classList.toggle('scdl-anchor-left', c.left + wrap.offsetWidth / 2 < window.innerWidth / 2);
    });

    const endDrag = (e) => {
      if (!wrap.classList.contains('scdl-dragging')) return;
      wrap.classList.remove('scdl-dragging');
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      const rect = wrap.getBoundingClientRect();
      const pos = snapFabPos(rect.left, rect.top, wrap.offsetWidth, wrap.offsetHeight,
                             window.innerWidth, window.innerHeight);
      applyFabPos(wrap, pos); // animates into the snapped spot
      if (moved) saveFabPos(pos);
    };
    grip.addEventListener('pointerup', endDrag);
    grip.addEventListener('pointercancel', endDrag);

    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      clearFabPos();
      applyFabPos(wrap, null);
    });

    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 32 : 8;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const pos = clampFabPos(rect.left + delta[0], rect.top + delta[1], wrap.offsetWidth, wrap.offsetHeight,
                              window.innerWidth, window.innerHeight);
      applyFabPos(wrap, pos);
      saveFabPos(pos);
    });
  }

  /* ------------------------------------------------------------------ *
   * Currently selected track (for the bubble)
   * ------------------------------------------------------------------ */

  function bgUrl(el) {
    if (!el) return '';
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    const url = m ? m[1] : '';
    return /^(https?:)?\/\//.test(url) ? url : '';
  }

  // SoundCloud wraps the real artwork in a sizing element that carries no
  // background of its own, so a plain querySelector finds the empty wrapper.
  // Walk every candidate and take the first that actually yields a URL.
  function findArtwork(scope) {
    if (!scope) return '';
    const els = scope.querySelectorAll(
      'span.sc-artwork, .image__full, [style*="background-image"], .sc-artwork, img'
    );
    for (const el of els) {
      if (el.tagName === 'IMG') {
        const src = el.currentSrc || el.src || '';
        if (/^(https?:)?\/\//.test(src)) return src;
        continue;
      }
      const url = bgUrl(el);
      if (url) return url;
    }
    return '';
  }

  // Whatever Alt+D would act on: the track page you are on, else what is playing.
  function getCurrentTrackInfo() {
    const pageUrl = trackUrlFromLocation();

    // Mirrors downloadCurrent() exactly: on a track page the page always wins,
    // so the bubble can never show a different track than the button acts on.
    if (pageUrl) {
      const titleEl = document.querySelector('.soundTitle__title span, .soundTitle__title');
      const userEl = document.querySelector('.soundTitle__username span, .soundTitle__username');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (title) {
        return {
          url: pageUrl,
          title,
          artist: userEl ? userEl.textContent.trim() : '',
          artwork: findArtwork(
            document.querySelector('.listenArtworkWrapper') ||
            document.querySelector('.fullListenHero') ||
            document.querySelector('.l-listen-hero') ||
            document.querySelector('.listenEngagement')
          ),
        };
      }
      // Hero has not rendered yet — show the slug meanwhile.
      const slug = decodeURIComponent(pageUrl.split('/').pop() || '').replace(/-/g, ' ').trim();
      return { url: pageUrl, title: slug || pageUrl, artist: '', artwork: '' };
    }

    const badge = document.querySelector('.playbackSoundBadge');
    const link = badge && badge.querySelector('.playbackSoundBadge__titleLink');
    if (link) {
      const artistEl = badge.querySelector('.playbackSoundBadge__lightLink');
      const title = (link.getAttribute('title') || link.textContent || '').trim();
      if (title) {
        return {
          url: link.href.split('?')[0],
          title,
          artist: artistEl ? (artistEl.getAttribute('title') || artistEl.textContent || '').trim() : '',
          artwork: findArtwork(badge),
        };
      }
    }

    return null;
  }

  let lastNowKey = null;

  function refreshNowBubble() {
    const wrap = document.querySelector('.scdl-fabs');
    if (!wrap) return;
    const bubble = wrap.querySelector('.scdl-now');
    const dl = wrap.querySelector('.scdl-fab-dl');
    if (!bubble || !dl) return;

    const info = getCurrentTrackInfo();
    const key = info ? [info.url, info.title, info.artist, info.artwork].join('|') : '';
    if (key === lastNowKey) return; // nothing changed, skip the DOM work
    const first = lastNowKey === null;
    lastNowKey = key;

    const titleEl = bubble.querySelector('.scdl-now-title');
    const artistEl = bubble.querySelector('.scdl-now-artist');
    const artEl = bubble.querySelector('.scdl-now-art');

    if (info) {
      bubble.classList.remove('scdl-now-empty');
      titleEl.textContent = info.title;
      artistEl.textContent = info.artist;
      artistEl.hidden = !info.artist;
      artEl.style.backgroundImage = info.artwork ? `url("${info.artwork}")` : '';
      bubble.href = info.url;
      bubble.title = `${info.artist ? info.artist + ' — ' : ''}${info.title}\n${T.openTrack}`;
      dl.disabled = false;
      dl.title = T.downloadTitle(info.title);
    } else {
      bubble.classList.add('scdl-now-empty');
      titleEl.textContent = T.nothingSelected;
      artistEl.textContent = '';
      artistEl.hidden = true;
      artEl.style.backgroundImage = '';
      bubble.removeAttribute('href'); // an anchor without href is inert
      bubble.title = T.nothingSelected;
      dl.disabled = true;
      dl.title = T.noTrack;
    }

    if (!first) {
      bubble.classList.remove('scdl-swap');
      void bubble.offsetWidth; // restart the fade
      bubble.classList.add('scdl-swap');
    }

    // The bubble width changes with the title, so re-clamp a saved position.
    const pos = loadFabPos();
    if (pos) applyFabPos(wrap, pos);
  }

  function downloadCurrent() {
    const url = trackUrlFromLocation() || nowPlayingUrl();
    if (!url) {
      toast(T.noTrack, 4000);
      return;
    }
    requestDownload(url);
  }

  function queueCurrent() {
    const url = trackUrlFromLocation() || nowPlayingUrl();
    if (!url) {
      toast(T.noTrack, 4000);
      return;
    }
    addToQueue(url);
  }

  function updateQueueBadge() {
    const btn = document.querySelector('.scdl-fab-queue');
    if (!btn) return;
    const n = getQueue().length;
    btn.hidden = n === 0;
    btn.querySelector('.scdl-badge').textContent = n;
  }

  function addFabs() {
    if (document.querySelector('.scdl-fabs')) return;

    const wrap = document.createElement('div');
    wrap.className = 'scdl-fabs';

    const queueBtn = document.createElement('button');
    queueBtn.className = 'scdl-fab scdl-fab-queue scdl-glass';
    queueBtn.type = 'button';
    queueBtn.title = 'Open download queue';
    queueBtn.innerHTML = `${escapeHtml(T.queue)} <span class="scdl-badge">0</span>`;
    queueBtn.hidden = true;
    queueBtn.addEventListener('click', openQueuePanel);

    const bubble = document.createElement('a');
    bubble.className = 'scdl-now scdl-glass scdl-now-empty';
    bubble.innerHTML =
      '<span class="scdl-now-art"></span>' +
      '<span class="scdl-now-text">' +
      `<span class="scdl-now-title">${escapeHtml(T.nothingSelected)}</span>` +
      '<span class="scdl-now-artist" hidden></span>' +
      '</span>';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'scdl-fab-dl';
    dlBtn.type = 'button';
    dlBtn.disabled = true;
    dlBtn.title = T.noTrack;
    dlBtn.setAttribute('aria-label', T.download);
    dlBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.5v11"/><path d="m7.2 10.3 4.8 4.8 4.8-4.8"/><path d="M4.5 19.5h15"/></svg>';
    dlBtn.addEventListener('click', downloadCurrent);

    const dock = document.createElement('div');
    dock.className = 'scdl-dock';
    // Order: bubble · queue · download (mirrored when docked to the left edge).
    dock.append(bubble, queueBtn, dlBtn);

    const grip = document.createElement('button');
    grip.className = 'scdl-grip scdl-glass';
    grip.type = 'button';
    grip.title = T.dragHint;
    grip.setAttribute('aria-label', T.dragHint);
    grip.innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i>';

    wrap.append(grip, dock);
    document.body.appendChild(wrap);

    applyFabPos(wrap, loadFabPos());
    makeFabDraggable(wrap, grip);
    updateQueueBadge();
    refreshNowBubble();
  }

  function trackUrlForNode(node) {
    const scope =
      node.closest('.sound, .listenEngagement, .soundList__item, .l-listen-hero, .trackItem') || document;
    const link = scope.querySelector(
      'a.soundTitle__title, a.trackItem__trackTitle, .playbackSoundBadge__titleLink'
    );
    return link ? link.href.split('?')[0] : trackUrlFromLocation();
  }

  function injectInlineButtons() {
    // Action bars in document order: outer containers come first.
    const bars = document.querySelectorAll('.soundActions, .listenEngagement__actions');
    const handled = [];

    for (const bar of bars) {
      // Already has our button -> remember it so nested bars are skipped.
      if (bar.querySelector('.scdl-inline')) {
        handled.push(bar);
        continue;
      }
      // Skip a bar nested inside one that already got a button (this is what
      // produced the duplicate button on track pages).
      if (handled.some((h) => h.contains(bar))) continue;

      const group = bar.querySelector('.sc-button-group');
      if (!group) continue;

      const url = trackUrlForNode(bar);
      if (!url) continue;

      const dl = document.createElement('button');
      dl.className = 'sc-button sc-button-small sc-button-responsive scdl-inline';
      dl.type = 'button';
      dl.textContent = T.inline;
      dl.title = 'Download with ID3 tags';
      dl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        requestDownload(trackUrlForNode(bar) || url);
      });

      const add = document.createElement('button');
      add.className = 'sc-button sc-button-small sc-button-responsive scdl-inline scdl-inline-add';
      add.type = 'button';
      add.textContent = '+';
      add.title = 'Add to download queue';
      add.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        addToQueue(trackUrlForNode(bar) || url);
      });

      group.append(dl, add);
      handled.push(bar);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') {
      e.preventDefault();
      downloadCurrent();
    } else if (k === 'q') {
      e.preventDefault();
      queueCurrent();
    }
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Download current track', downloadCurrent);
    GM_registerMenuCommand('Add current track to queue', queueCurrent);
    GM_registerMenuCommand('Open download queue', openQueuePanel);
    GM_registerMenuCommand('Refresh SoundCloud client_id', async () => {
      try {
        await getClientId(true);
        toast('client_id refreshed.');
      } catch (e) {
        toast('Failed: ' + e.message, 5000);
      }
    });
  }

  window.addEventListener('resize', () => {
    const wrap = document.querySelector('.scdl-fabs');
    const pos = loadFabPos();
    if (wrap && pos) applyFabPos(wrap, pos);
  });

  addFabs();
  injectInlineButtons();

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      addFabs();
      injectInlineButtons();
      refreshNowBubble();
    }, 400);
  }).observe(document.body, { childList: true, subtree: true });
})();
