// ==UserScript==
// @name         X/Twitter GIF Favorites
// @namespace    https://local/twitter-gif-favorites
// @version      2.0.0
// @description  Star GIFs on X/Twitter to save them as real, locally-stored .gif files, then repost them in one click from a button added to the tweet/reply toolbar.
// @author       SharpeurNes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      video.twimg.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const INDEX_KEY = 'tgf_index_v3'; // small metadata list: [{ id, videoUrl, tweetUrl, sizeBytes, addedAt }]
  const LEGACY_KEY = 'tgf_favorites_v2'; // v1.x format: one huge JSON blob holding every GIF
  const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';
  const GIF_URL_RE = /\/tweet_video\//; // X serves GIFs as MP4s under this path (regular videos are blob: streams)

  // MP4 -> GIF conversion settings
  const GIF_MAX_FRAMES = 90;
  const GIF_MAX_WIDTH = 480;
  const GIF_FPS = 12;
  const GIF_MAX_DURATION = 15; // seconds, safety cap

  // How many times a video that doesn't look like a GIF (yet) is re-examined before we give up on it
  const MAX_VIDEO_CHECKS = 3;

  // ---------- Storage ----------
  // Layout: one small index + one key per GIF (and per poster). Nothing parses the whole
  // collection any more: the star icons only need the in-memory index, and a GIF's data
  // is read only when it is actually inserted / previewed / downloaded.
  const gifKey = (id) => `tgf_gif_${id}`;
  const posterKey = (id) => `tgf_poster_${id}`;

  function makeId(videoUrl) {
    const m = videoUrl.match(/\/tweet_video\/([\w-]+)\./);
    if (m) return m[1];
    let h = 0x811c9dc5; // FNV-1a fallback
    for (let i = 0; i < videoUrl.length; i++) {
      h ^= videoUrl.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return 'h' + (h >>> 0).toString(16) + videoUrl.length.toString(16);
  }

  let indexCache = null;
  let urlSet = new Set();
  function setIndex(list) {
    indexCache = list;
    urlSet = new Set(list.map((f) => f.videoUrl));
  }
  function readIndexFromStorage() {
    try {
      const v = JSON.parse(GM_getValue(INDEX_KEY, '[]'));
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }
  function getFavorites() {
    if (!indexCache) setIndex(readIndexFromStorage());
    return indexCache;
  }
  // Re-read from storage right before any change, so two open tabs don't overwrite each other.
  function reloadIndex() {
    setIndex(readIndexFromStorage());
    return indexCache;
  }
  function saveIndex(list) {
    GM_setValue(INDEX_KEY, JSON.stringify(list));
    setIndex(list);
  }
  function isFavorited(videoUrl) {
    getFavorites();
    return urlSet.has(videoUrl);
  }
  function addFavorite(item) {
    const list = reloadIndex().slice();
    if (list.some((f) => f.videoUrl === item.videoUrl)) return false;
    const id = makeId(item.videoUrl);
    // Data first, index last: the index never points to missing data.
    GM_setValue(gifKey(id), item.gifDataUrl);
    if (item.posterUrl) GM_setValue(posterKey(id), item.posterUrl);
    list.unshift({
      id,
      videoUrl: item.videoUrl,
      tweetUrl: item.tweetUrl || '',
      sizeBytes: item.sizeBytes || 0,
      addedAt: item.addedAt || Date.now(),
    });
    saveIndex(list);
    return true;
  }
  function removeFavorite(videoUrl) {
    const list = reloadIndex();
    const entry = list.find((f) => f.videoUrl === videoUrl);
    if (!entry) return;
    saveIndex(list.filter((f) => f !== entry));
    GM_deleteValue(gifKey(entry.id));
    GM_deleteValue(posterKey(entry.id));
  }
  function clearFavorites() {
    const list = reloadIndex();
    saveIndex([]);
    list.forEach((f) => {
      GM_deleteValue(gifKey(f.id));
      GM_deleteValue(posterKey(f.id));
    });
  }
  const getGif = (entry) => GM_getValue(gifKey(entry.id), '');
  const getPoster = (entry) => GM_getValue(posterKey(entry.id), '');
  const setPoster = (entry, dataUrl) => GM_setValue(posterKey(entry.id), dataUrl);

  // One-time move from the v1.x single-blob format. The old data is deleted only after
  // every GIF has been written and read back with the same size.
  function migrateLegacyFavorites() {
    let old;
    try {
      old = JSON.parse(GM_getValue(LEGACY_KEY, '[]'));
    } catch (e) {
      return 0; // unreadable: leave it untouched
    }
    if (!Array.isArray(old) || old.length === 0) return 0;

    const usable = old.filter((f) => f && f.videoUrl && f.gifDataUrl);
    const index = reloadIndex().slice();
    const known = new Set(index.map((f) => f.videoUrl));
    let moved = 0;
    for (const f of usable) {
      if (known.has(f.videoUrl)) continue;
      const id = makeId(f.videoUrl);
      GM_setValue(gifKey(id), f.gifDataUrl);
      if (f.posterUrl) GM_setValue(posterKey(id), f.posterUrl);
      index.push({
        id,
        videoUrl: f.videoUrl,
        tweetUrl: f.tweetUrl || '',
        sizeBytes: f.sizeBytes || 0,
        addedAt: f.addedAt || 0,
      });
      known.add(f.videoUrl);
      moved++;
    }
    index.sort((a, b) => b.addedAt - a.addedAt);
    saveIndex(index);

    const verified = usable.every((f) => GM_getValue(gifKey(makeId(f.videoUrl)), '').length === f.gifDataUrl.length);
    if (verified) GM_deleteValue(LEGACY_KEY);
    return moved;
  }

  // ---------- Network ----------
  // GM_xmlhttpRequest wrapped in a promise: HTTP errors, timeouts and aborts all reject
  // (the raw callback API silently "succeeds" on a 403/404).
  function gmRequest(opts, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        timeout,
        ...opts,
        onload: (res) => (res.status >= 200 && res.status < 300 ? resolve(res) : reject(new Error(`HTTP ${res.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
        onabort: () => reject(new Error('aborted')),
      });
    });
  }

  if (typeof globalThis.__TGF_EXPORT__ === 'function') {
    globalThis.__TGF_EXPORT__({
      makeId,
      getFavorites,
      isFavorited,
      addFavorite,
      removeFavorite,
      clearFavorites,
      getGif,
      getPoster,
      setPoster,
      migrateLegacyFavorites,
      gmRequest,
    });
  }
  if (typeof document === 'undefined') return; // running under Node (tests)

  // ---------- Shared UI state ----------
  let panelEl, gridEl;
  let currentAnchor = null; // toolbar the panel is attached to
  let activeFileInput = null; // file input of that toolbar (only while the panel is open)
  let lastComposer = null;
  let converting = false; // one GIF conversion at a time

  // ---------- Theme (light/dark/dim) detected on the fly ----------
  function applyTheme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    const nums = bg.match(/\d+/g);
    let isDark = true;
    if (nums && nums.length >= 3) {
      const [r, g, b] = nums.map(Number);
      isDark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    const root = document.documentElement.style;
    if (isDark) {
      root.setProperty('--tgf-surface', 'rgba(32,35,39,0.9)');
      root.setProperty('--tgf-border', 'rgba(255,255,255,0.15)');
      root.setProperty('--tgf-panel-bg', '#15202b');
      root.setProperty('--tgf-panel-border', '#38444d');
      root.setProperty('--tgf-text', '#e7e9ea');
      root.setProperty('--tgf-muted', '#8b98a5');
      root.setProperty('--tgf-hover', 'rgba(255,255,255,0.08)');
    } else {
      root.setProperty('--tgf-surface', 'rgba(255,255,255,0.9)');
      root.setProperty('--tgf-border', 'rgba(0,0,0,0.12)');
      root.setProperty('--tgf-panel-bg', '#ffffff');
      root.setProperty('--tgf-panel-border', '#eff3f4');
      root.setProperty('--tgf-text', '#0f1419');
      root.setProperty('--tgf-muted', '#536471');
      root.setProperty('--tgf-hover', 'rgba(15,20,25,0.07)');
    }
  }

  // ---------- Styles ----------
  GM_addStyle(`
    .tgf-star-btn {
      position: absolute;
      top: 8px;
      left: 8px;
      z-index: 50;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border: none;
      transition: transform 0.15s ease, background 0.15s ease;
    }
    .tgf-star-btn:hover { transform: scale(1.12); background: rgba(0,0,0,0.55); }
    .tgf-star-btn svg { width: 13px; height: 13px; }
    .tgf-spin { animation: tgf-rotate 0.8s linear infinite; }
    @keyframes tgf-rotate { to { transform: rotate(360deg); } }

    .tgf-toolbar-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .tgf-toolbar-btn svg { display: block; width: 20px; height: 20px; }

    .tgf-panel {
      position: fixed;
      right: 20px;
      top: 70px;
      z-index: 9999;
      box-sizing: border-box; /* so the inline max-height set while positioning includes the border */
      width: 344px;
      max-height: 520px;
      background: var(--tgf-panel-bg, #15202b);
      border: 1px solid var(--tgf-panel-border, #38444d);
      border-radius: 16px;
      display: none;
      flex-direction: column;
      overflow: hidden;
      font-family: "TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--tgf-text, #e7e9ea);
      box-shadow: 0 0 15px rgba(101,119,134,0.2), 0 0 3px 1px rgba(101,119,134,0.15);
    }
    .tgf-panel.tgf-open { display: flex; animation: tgf-pop 0.14s ease-out; }
    @keyframes tgf-pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .tgf-panel.tgf-open { animation: none; } }

    .tgf-panel-header {
      padding: 10px 10px 10px 16px;
      display: flex;
      align-items: center;
      gap: 4px;
      border-bottom: 1px solid var(--tgf-panel-border, #38444d);
    }
    .tgf-title { display: flex; align-items: center; gap: 8px; margin-right: auto; min-width: 0; }
    .tgf-title svg { width: 18px; height: 18px; flex: none; }
    .tgf-title strong { font-size: 16px; font-weight: 800; white-space: nowrap; }
    .tgf-count {
      font-size: 12px;
      color: var(--tgf-muted, #8b98a5);
      background: var(--tgf-hover, rgba(255,255,255,0.08));
      border-radius: 999px;
      padding: 2px 8px;
      white-space: nowrap;
    }
    .tgf-count:empty { display: none; }
    .tgf-iconbtn {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 34px; height: 34px; padding: 0; border: none; border-radius: 999px;
      background: transparent; color: var(--tgf-muted, #8b98a5); cursor: pointer;
      font: inherit; font-size: 13px; font-weight: 700;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .tgf-iconbtn[hidden] { display: none; }
    .tgf-iconbtn svg { width: 18px; height: 18px; }
    .tgf-iconbtn:hover { background: var(--tgf-hover, rgba(255,255,255,0.08)); color: var(--tgf-text, #e7e9ea); }
    .tgf-iconbtn:focus-visible, .tgf-item:focus-visible, .tgf-act:focus-visible { outline: 2px solid var(--tgf-accent, #1d9bf0); outline-offset: 1px; }
    .tgf-iconbtn.tgf-confirm { background: var(--tgf-danger, #f4212e); color: #fff; padding: 0 12px; }
    .tgf-iconbtn.tgf-confirm:hover { background: #dc1b27; color: #fff; }

    .tgf-grid {
      padding: 12px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      /* Fixed-size rows: with the default auto rows, the cards (overflow:hidden => min size 0) get squeezed
         to fit the panel height instead of making the grid scroll, so they end up squashed and overlapping. */
      grid-auto-rows: max-content;
      align-content: start;
      gap: 6px;
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: var(--tgf-panel-border, #38444d) transparent;
    }
    .tgf-empty {
      grid-column: 1 / -1;
      padding: 28px 18px 24px;
      text-align: center;
      color: var(--tgf-muted, #8b98a5);
      font-size: 14px;
      line-height: 1.4;
    }
    .tgf-empty svg { width: 40px; height: 40px; margin-bottom: 8px; opacity: 0.55; }
    .tgf-empty strong { display: block; color: var(--tgf-text, #e7e9ea); font-size: 17px; font-weight: 800; margin-bottom: 4px; }

    .tgf-item {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      background: #000;
      aspect-ratio: 1 / 1;
      cursor: pointer;
      border: 1px solid var(--tgf-border, rgba(255,255,255,0.15));
      background-clip: padding-box; /* else the translucent border blends with the black background and looks like a dark outline */
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    .tgf-item:hover, .tgf-item:focus-visible { transform: scale(1.03); z-index: 2; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
    .tgf-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tgf-item::after { /* darkens the top edge so the action buttons stay readable on any GIF */
      content: ''; position: absolute; inset: 0 0 auto 0; height: 44px; pointer-events: none;
      background: linear-gradient(rgba(0,0,0,0.55), transparent); opacity: 0; transition: opacity 0.12s ease;
    }
    .tgf-item:hover::after, .tgf-item:focus-within::after { opacity: 1; }
    .tgf-actions {
      position: absolute; top: 4px; right: 4px; z-index: 3; display: flex; gap: 3px;
      opacity: 0; transition: opacity 0.12s ease;
    }
    .tgf-item:hover .tgf-actions, .tgf-item:focus-within .tgf-actions { opacity: 1; }
    .tgf-act {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%;
      background: rgba(0,0,0,0.55); color: #fff; cursor: pointer;
      transition: background 0.12s ease;
    }
    .tgf-act svg { width: 14px; height: 14px; }
    .tgf-act:hover { background: rgba(0,0,0,0.85); }
    .tgf-act.tgf-del:hover { background: var(--tgf-danger, #f4212e); }
    .tgf-size {
      position: absolute; left: 5px; bottom: 5px; z-index: 3; padding: 1px 6px; border-radius: 999px;
      font-size: 10px; font-weight: 700; color: #fff; background: rgba(0,0,0,0.6);
      opacity: 0; transition: opacity 0.12s ease; pointer-events: none;
    }
    .tgf-item:hover .tgf-size, .tgf-item:focus-within .tgf-size { opacity: 1; }
    .tgf-footer {
      padding: 8px 16px 10px; font-size: 12px; color: var(--tgf-muted, #8b98a5);
      border-top: 1px solid var(--tgf-panel-border, #38444d);
    }
    .tgf-footer:empty { display: none; }
    .tgf-toast {
      position: fixed;
      bottom: 90px;
      left: 50%;
      transform: translateX(-50%);
      background: #1d9bf0;
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.25s ease;
      pointer-events: none;
      max-width: 80vw;
      text-align: center;
    }
    .tgf-toast.tgf-show { opacity: 1; }
  `);

  // ---------- Toast ----------
  let toastEl;
  function toast(msg, duration = 2200) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'tgf-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('tgf-show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('tgf-show'), duration);
  }

  // ---------- Icons ----------
  const STAR_OUTLINE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/></svg>';
  const STAR_FILLED =
    '<svg viewBox="0 0 24 24" fill="#ffd400"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/></svg>';
  const STAR_LOADING =
    '<svg class="tgf-spin" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9"/></svg>';

  // ---------- File utilities ----------
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  // X blocks fetch() on data: URLs via its Content-Security-Policy (connect-src).
  // So we decode the base64 by hand: no network request, so no CSP issue.
  function dataUrlToBlob(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    const header = dataUrl.slice(0, commaIdx);
    const base64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/gif';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  // For favorites that have no stored poster (e.g. migrated from a very old version):
  // decode the first frame of the saved GIF into a static image, so it isn't animated
  // until it's hovered.
  function generatePosterFromGif(gifDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.dataset.tgfOwn = '1';
      img.style.position = 'fixed';
      img.style.left = '-9999px';
      img.style.width = '1px';
      img.style.height = '1px';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 160;
          canvas.height = img.naturalHeight || 160;
          canvas.getContext('2d').drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        } catch (err) {
          reject(err);
        } finally {
          img.remove();
        }
      };
      img.onerror = () => {
        img.remove();
        reject(new Error('poster generation failed'));
      };
      document.body.appendChild(img);
      img.src = gifDataUrl;
    });
  }
  const posterGenerationInFlight = new Set();

  // Saves a single favorite as a real .gif file in the browser's normal
  // Downloads folder, so it can be found with a regular file explorer.
  function downloadFavoriteFile(entry) {
    const gif = getGif(entry);
    if (!gif) {
      toast('GIF data not found');
      return;
    }
    const url = URL.createObjectURL(dataUrlToBlob(gif));
    const a = document.createElement('a');
    a.href = url;
    a.download = `favorite-gif-${entry.addedAt || entry.id}.gif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Downloading .gif file...');
  }

  // ---------- GIF detection & star button injection ----------
  function extractVideoUrl(video) {
    return video.currentSrc || video.src || (video.querySelector('source') || {}).src || '';
  }
  function getTweetUrl(article) {
    const timeEl = article.querySelector('a[href*="/status/"] time');
    const link = timeEl && timeEl.parentElement;
    if (link) {
      try {
        return new URL(link.getAttribute('href'), 'https://x.com').href;
      } catch (e) {
        return '';
      }
    }
    return '';
  }
  function hasGifBadge(video) {
    const container = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (!container) return false;
    return Array.from(container.querySelectorAll('span, div')).some(
      (el) => el.childElementCount === 0 && el.textContent.trim() === 'GIF'
    );
  }
  function isGifVideo(video) {
    const url = extractVideoUrl(video);
    if (GIF_URL_RE.test(url)) return true; // language-independent, unlike the "GIF" badge text
    if (!/^https?:/.test(url)) return false; // not loaded yet, or a blob: stream (regular video)
    return hasGifBadge(video); // fallback if X ever serves GIFs from another path
  }

  const starButtons = new WeakMap(); // video -> its star button
  const videoChecks = new WeakMap(); // video -> how many times it was examined without being a GIF

  function attachStar(video, btn) {
    const container = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(btn);
  }

  function createStar(video) {
    const btn = document.createElement('button');
    btn.className = 'tgf-star-btn';
    btn.type = 'button';

    btn._tgfRefresh = () => {
      if (btn.dataset.busy === '1') return;
      const url = extractVideoUrl(video);
      btn.innerHTML = url && isFavorited(url) ? STAR_FILLED : STAR_OUTLINE;
    };
    btn._tgfRefresh();

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = extractVideoUrl(video);
      if (!url || url.startsWith('blob:')) {
        toast('GIF not loaded yet — let it play for a second, then try again ⭐');
        return;
      }

      if (isFavorited(url)) {
        removeFavorite(url);
        toast('GIF removed from favorites and deleted from local storage');
        refreshStars();
        renderPanel();
        return;
      }

      if (converting) {
        toast('Another GIF is being converted, please wait a moment');
        return;
      }
      converting = true;
      btn.dataset.busy = '1';
      btn.innerHTML = STAR_LOADING;
      toast('Converting to GIF...', 60000);
      try {
        const res = await gmRequest({ url, responseType: 'arraybuffer' }, 60000);
        const mp4Blob = new Blob([res.response], { type: 'video/mp4' });
        const { blob: gifBlob, poster: posterUrl } = await convertMp4BlobToGif(mp4Blob, (p) => {
          toast(`Converting to GIF... ${Math.round(Math.min(p, 1) * 100)}%`, 60000);
        });
        const gifDataUrl = await blobToDataUrl(gifBlob);
        const article = video.closest('article');
        addFavorite({
          videoUrl: url,
          gifDataUrl,
          posterUrl,
          sizeBytes: gifBlob.size,
          tweetUrl: article ? getTweetUrl(article) : '',
          addedAt: Date.now(),
        });
        toast('GIF converted and saved to favorites ⭐');
        renderPanel();
      } catch (err) {
        console.error('[TGF]', err);
        toast(`Couldn't convert this GIF (${err.message})`);
      } finally {
        converting = false;
        btn.dataset.busy = '';
        refreshStars();
      }
    });
    return btn;
  }

  function injectStar(video) {
    // Ignore anything the script created itself (previews, hidden conversion video)
    if (video.hasAttribute('data-tgf-own') || video.closest('.tgf-panel')) return;

    const existing = starButtons.get(video);
    if (existing) {
      // X can re-render the player and drop our button: put it back.
      if (!existing.isConnected) attachStar(video, existing);
      return;
    }

    const checks = videoChecks.get(video) || 0;
    if (checks >= MAX_VIDEO_CHECKS) return;
    if (!isGifVideo(video)) {
      // A blob: source is a regular video for good; otherwise give it a couple more chances.
      videoChecks.set(video, extractVideoUrl(video).startsWith('blob:') ? MAX_VIDEO_CHECKS : checks + 1);
      return;
    }

    const btn = createStar(video);
    starButtons.set(video, btn);
    attachStar(video, btn);
  }

  function scanForGifs(root) {
    root.querySelectorAll('video').forEach(injectStar);
  }

  // Re-sync every visible star with the favorites list (after a removal in the panel, etc.)
  function refreshStars() {
    document.querySelectorAll('.tgf-star-btn').forEach((b) => b._tgfRefresh && b._tgfRefresh());
  }

  // ---------- Track the active compose box ----------
  document.addEventListener(
    'focusin',
    (e) => {
      const box = e.target.closest('[data-testid^="tweetTextarea"], div[role="textbox"]');
      if (box) {
        lastComposer = box;
        // The toolbar (media/GIF/emoji...) is often mounted right when the box gets focus,
        // so we re-scan shortly after to catch it as soon as it appears.
        setTimeout(() => scanForToolbars(document), 250);
        setTimeout(() => scanForToolbars(document), 800);
      }
    },
    true
  );

  function findFileInputFrom(node) {
    let n = node;
    for (let i = 0; i < 15 && n; i++) {
      const input = n.querySelector && n.querySelector('input[type="file"]');
      if (input) return input;
      n = n.parentElement;
    }
    return null;
  }

  function findFileInput() {
    if (activeFileInput && document.contains(activeFileInput)) return activeFileInput;
    const fromComposer = lastComposer ? findFileInputFrom(lastComposer) : null;
    if (fromComposer) return fromComposer;
    return (
      document.querySelector('input[data-testid="fileInput"]') ||
      document.querySelector('input[type="file"]')
    );
  }

  // ---------- Panel open / close ----------
  function openPanel(anchor, fileInput) {
    currentAnchor = anchor || null;
    activeFileInput = fileInput || null;
    if (anchor) {
      positionPanelNear(anchor);
    } else {
      // Opened from the Tampermonkey menu: back to the default corner position from the CSS.
      Object.assign(panelEl.style, { left: '', right: '', top: '', bottom: '', maxHeight: '' });
    }
    panelEl.classList.add('tgf-open');
    renderPanel();
  }
  function closePanel() {
    if (panelEl) {
      panelEl.classList.remove('tgf-open');
      if (panelEl._resetClear) panelEl._resetClear();
    }
    currentAnchor = null;
    activeFileInput = null; // otherwise the next insert could target a stale composer
  }

  // ---------- Button embedded in the composer toolbar ----------
  function injectToolbarButton(toolbar) {
    if (toolbar.hasAttribute('data-tgf-toolbar-done')) return;

    // The "Content disclosure" button (the flag, last in the row) is used as the
    // anchor and template, so our star is inserted at the very end of the icon row.
    const anchorButton =
      toolbar.querySelector('[data-testid="contentDisclosureButton"]') ||
      toolbar.querySelector('[data-testid="gifSearchButton"]');
    if (!anchorButton) return; // not mounted yet, we'll retry on the next scan

    toolbar.setAttribute('data-tgf-toolbar-done', '1');

    const slide = anchorButton.closest('[role="presentation"]') || anchorButton.parentElement;
    const clonedSlide = slide.cloneNode(true);

    const clonedButton = clonedSlide.querySelector('[role="button"]') || clonedSlide;
    clonedButton.classList.add('tgf-toolbar-btn');
    clonedButton.removeAttribute('data-testid');
    clonedButton.setAttribute('aria-label', 'My favorite GIFs');
    clonedButton.title = 'My favorite GIFs';

    const svg = clonedButton.querySelector('svg');
    if (svg) {
      // fill="currentColor": matches the exact same gray tone as the other icons
      // (instead of a bright yellow that stands out too much), while staying recognizable.
      svg.innerHTML = '<path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/>';
    }

    clonedButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(toolbar, toolbar.querySelector('input[type="file"]') || findFileInputFrom(toolbar));
    });

    slide.insertAdjacentElement('afterend', clonedSlide);
  }

  function findToolbars(root) {
    return Array.from((root.querySelectorAll ? root : document).querySelectorAll('[data-testid="toolBar"]'));
  }

  function scanForToolbars(root) {
    findToolbars(root).forEach((toolbar) => {
      const before = toolbar.hasAttribute('data-tgf-toolbar-done');
      injectToolbarButton(toolbar);
      if (!before && toolbar.hasAttribute('data-tgf-toolbar-done')) {
        console.log('[TGF] Favorite button added to a toolbar:', toolbar);
      }
    });
  }

  // Positions the panel next to the toolbar, left-aligned, like X's native emoji picker does.
  // It opens downward whenever there's a reasonable amount of room below the toolbar, and only
  // flips upward when there's little room below and more above (e.g. a reply box at the bottom
  // of the screen). Its height is clamped to the space actually available so it always stays
  // fully on-screen (the grid inside then scrolls normally).
  function positionPanelNear(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const width = panelEl.offsetWidth || 344;
    const gap = 8; // between the toolbar and the panel
    const edge = 8; // minimum distance to the screen border
    const maxPanelHeight = 520;
    const comfortableHeight = 300; // header + a couple of rows + footer

    let left = rect.left;
    if (left + width > window.innerWidth - edge) left = window.innerWidth - width - edge;
    if (left < edge) left = edge;
    panelEl.style.left = left + 'px';
    panelEl.style.right = 'auto';

    const spaceAbove = rect.top - gap - edge;
    const spaceBelow = window.innerHeight - rect.bottom - gap - edge;

    if (spaceBelow >= comfortableHeight || spaceBelow >= spaceAbove) {
      panelEl.style.bottom = 'auto';
      panelEl.style.top = rect.bottom + gap + 'px';
      panelEl.style.maxHeight = Math.max(150, Math.min(maxPanelHeight, spaceBelow)) + 'px';
    } else {
      panelEl.style.top = 'auto';
      panelEl.style.bottom = window.innerHeight - rect.top + gap + 'px';
      panelEl.style.maxHeight = Math.max(150, Math.min(maxPanelHeight, spaceAbove)) + 'px';
    }
  }

  // Keep the open panel glued to its anchor toolbar while the page (or the
  // reply/tweet modal, or the timeline) scrolls. `scroll` doesn't bubble, so the
  // listener is registered on the capture phase to catch it from any container.
  // If the anchor has been removed from the page (e.g. X swapped the view via
  // client-side navigation, without a real page reload), close the panel
  // instead of leaving it stranded on screen.
  function followAnchor() {
    if (!panelEl || !panelEl.classList.contains('tgf-open') || !currentAnchor) return;
    if (!document.contains(currentAnchor)) {
      closePanel();
      return;
    }
    positionPanelNear(currentAnchor);
  }
  window.addEventListener('scroll', followAnchor, true);
  window.addEventListener('resize', followAnchor);

  function attachFileToComposer(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertFavorite(entry) {
    const input = findFileInput();
    if (!input) {
      toast('Open a tweet or reply box first 📝');
      return;
    }
    const gif = getGif(entry);
    if (!gif) {
      toast('GIF data not found');
      return;
    }
    try {
      const file = new File([dataUrlToBlob(gif)], `gif-${Date.now()}.gif`, { type: 'image/gif' });
      attachFileToComposer(input, file);
      toast('GIF added to the tweet ✅');
      closePanel();
    } catch (err) {
      console.error('[TGF]', err);
      toast('Error inserting the GIF');
    }
  }

  // ---------- MP4 -> real animated GIF conversion ----------
  let workerBlobUrlPromise = null;
  function getWorkerBlobUrl() {
    if (!workerBlobUrlPromise) {
      workerBlobUrlPromise = gmRequest({ url: GIF_WORKER_URL })
        .then((res) => URL.createObjectURL(new Blob([res.responseText], { type: 'application/javascript' })))
        .catch((err) => {
          workerBlobUrlPromise = null; // don't cache a failure: the next attempt must retry
          throw err;
        });
    }
    return workerBlobUrlPromise;
  }

  // Resolves once the first frame is decoded (readyState >= 2): drawing before that gives a blank frame.
  function waitForVideoData(video, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onOk);
        video.removeEventListener('error', onErr);
      };
      const onOk = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error('video load error'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('video load timeout'));
      }, timeoutMs);
      video.addEventListener('loadeddata', onOk);
      video.addEventListener('error', onErr);
    });
  }

  function seekTo(video, time, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      // Setting currentTime to its current value may never fire "seeked": nothing to wait for.
      if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) {
        resolve();
        return;
      }
      const handler = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', handler);
        resolve();
      };
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', handler);
        reject(new Error('video seek timeout'));
      }, timeoutMs);
      video.addEventListener('seeked', handler);
      video.currentTime = time;
    });
  }

  async function convertMp4BlobToGif(mp4Blob, onProgress) {
    if (typeof GIF === 'undefined') throw new Error('gif.js not loaded');
    const workerScript = await getWorkerBlobUrl();
    const videoUrl = URL.createObjectURL(mp4Blob);
    const video = document.createElement('video');
    video.dataset.tgfOwn = '1'; // excluded from the GIF scan
    video.src = videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    document.body.appendChild(video);

    try {
      await waitForVideoData(video);

      const duration = Math.min(video.duration || 3, GIF_MAX_DURATION);
      let fps = GIF_FPS;
      let frameCount = Math.max(1, Math.round(duration * fps));
      if (frameCount > GIF_MAX_FRAMES) {
        fps = GIF_MAX_FRAMES / duration;
        frameCount = GIF_MAX_FRAMES;
      }

      let width = video.videoWidth || 480;
      let height = video.videoHeight || 270;
      if (width > GIF_MAX_WIDTH) {
        height = Math.round((height * GIF_MAX_WIDTH) / width);
        width = GIF_MAX_WIDTH;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      const gif = new GIF({ workers: 2, quality: 10, width, height, workerScript });

      let posterDataUrl = null;
      for (let i = 0; i < frameCount; i++) {
        const t = Math.max(0, Math.min(duration - 0.02, i / fps));
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, width, height);
        if (i === 0) {
          // Static snapshot of the first frame, used as a lightweight non-animated
          // thumbnail in the favorites panel (see renderPanel / hover-to-play below).
          posterDataUrl = canvas.toDataURL('image/jpeg', 0.72);
        }
        gif.addFrame(ctx, { copy: true, delay: Math.round(1000 / fps) });
        if (onProgress) onProgress(0.1 + (i / frameCount) * 0.5);
      }

      const resultBlob = await new Promise((resolve, reject) => {
        gif.on('progress', (p) => onProgress && onProgress(0.6 + p * 0.4));
        gif.on('finished', (blob) => resolve(blob));
        gif.on('abort', () => reject(new Error('gif encoding aborted')));
        try {
          gif.render();
        } catch (err) {
          reject(err);
        }
      });

      return { blob: resultBlob, poster: posterDataUrl };
    } finally {
      video.remove();
      URL.revokeObjectURL(videoUrl);
    }
  }

  // ---------- Favorites panel ----------
  const PANEL_ICONS = {
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    star: '<path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/>',
  };
  const panelIcon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PANEL_ICONS[name]}</svg>`;

  const formatSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'tgf-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'My favorite GIFs');
    panelEl.innerHTML = `
      <div class="tgf-panel-header">
        <div class="tgf-title">
          <svg viewBox="0 0 24 24" fill="#ffd400" aria-hidden="true">${PANEL_ICONS.star}</svg>
          <strong>My GIFs</strong>
          <span class="tgf-count"></span>
        </div>
        <button type="button" class="tgf-iconbtn tgf-clear" title="Delete all" aria-label="Delete all favorite GIFs">${panelIcon('trash')}</button>
        <button type="button" class="tgf-iconbtn tgf-close" title="Close" aria-label="Close">${panelIcon('close')}</button>
      </div>
      <div class="tgf-grid"></div>
      <div class="tgf-footer"></div>
    `;
    document.body.appendChild(panelEl);
    gridEl = panelEl.querySelector('.tgf-grid');

    panelEl.querySelector('.tgf-close').addEventListener('click', closePanel);

    // "Delete all" asks for a second click instead of a blocking confirm() dialog.
    const clearBtn = panelEl.querySelector('.tgf-clear');
    let clearTimer;
    const resetClear = () => {
      clearTimeout(clearTimer);
      clearBtn.classList.remove('tgf-confirm');
      clearBtn.innerHTML = panelIcon('trash');
    };
    clearBtn.addEventListener('click', () => {
      if (!clearBtn.classList.contains('tgf-confirm')) {
        clearBtn.classList.add('tgf-confirm');
        clearBtn.textContent = 'Delete all?';
        clearTimer = setTimeout(resetClear, 3000);
        return;
      }
      resetClear();
      clearFavorites();
      refreshStars();
      renderPanel();
    });
    panelEl._resetClear = resetClear;

    // Close the panel when clicking outside it (and outside the button that opens it)
    document.addEventListener('click', (e) => {
      if (!panelEl.classList.contains('tgf-open')) return;
      // composedPath() is captured at dispatch time: e.target may already have been
      // detached by a handler that re-rendered part of the panel (e.g. the "Delete all" button).
      if (e.composedPath().includes(panelEl)) return;
      if (e.target.closest && e.target.closest('.tgf-toolbar-btn')) return;
      closePanel();
    });
    // Escape closes only the panel (capture phase: X doesn't also close its reply modal)
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !panelEl.classList.contains('tgf-open')) return;
        e.stopPropagation();
        closePanel();
      },
      true
    );
  }

  function makeAction(cls, title, icon, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tgf-act ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = panelIcon(icon);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function buildPanelItem(entry) {
    const el = document.createElement('div');
    el.className = 'tgf-item';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Add this GIF to your post');

    const img = document.createElement('img');
    img.dataset.tgfOwn = '1';
    img.alt = 'Favorite GIF';

    const actions = document.createElement('div');
    actions.className = 'tgf-actions';
    if (entry.tweetUrl) {
      actions.append(makeAction('tgf-open', 'Open the original post', 'external', () => window.open(entry.tweetUrl, '_blank', 'noopener')));
    }
    actions.append(
      makeAction('tgf-dl', 'Download as .gif file', 'download', () => downloadFavoriteFile(entry)),
      makeAction('tgf-del', 'Remove from favorites', 'trash', () => {
        removeFavorite(entry.videoUrl);
        refreshStars();
        renderPanel();
      })
    );

    const size = document.createElement('span');
    size.className = 'tgf-size';
    size.textContent = formatSize(entry.sizeBytes || 0);

    el.append(img, size, actions);

    // Hover-to-play: a static poster is shown, the (heavy) GIF data is only read on hover.
    const enableHoverPlay = (poster) => {
      el.addEventListener('mouseenter', () => {
        img.src = getGif(entry);
      });
      el.addEventListener('mouseleave', () => {
        img.src = poster;
      });
    };

    const poster = getPoster(entry);
    if (poster) {
      img.src = poster;
      enableHoverPlay(poster);
    } else if (!posterGenerationInFlight.has(entry.id)) {
      // No poster stored: build one from the GIF itself, cache it, and stop it from animating.
      const gif = getGif(entry);
      img.src = gif;
      posterGenerationInFlight.add(entry.id);
      generatePosterFromGif(gif)
        .then((generated) => {
          setPoster(entry, generated);
          img.src = generated;
          enableHoverPlay(generated);
        })
        .catch(() => {
          // If generation fails, leave it playing continuously.
        })
        .finally(() => posterGenerationInFlight.delete(entry.id));
    }

    el.addEventListener('click', () => insertFavorite(entry));
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        insertFavorite(entry);
      }
    });
    return el;
  }

  // Only does work while the panel is open (it's rebuilt from scratch every time it opens).
  function renderPanel() {
    if (!gridEl || !panelEl.classList.contains('tgf-open')) return;
    const favorites = getFavorites();
    const countEl = panelEl.querySelector('.tgf-count');
    const totalBytes = favorites.reduce((s, f) => s + (f.sizeBytes || 0), 0);
    countEl.textContent = favorites.length ? `${favorites.length} · ${formatSize(totalBytes)}` : '';
    panelEl.querySelector('.tgf-clear').hidden = favorites.length === 0;
    panelEl.querySelector('.tgf-footer').textContent = favorites.length
      ? activeFileInput
        ? 'Click a GIF to add it · hover to preview'
        : 'Open a post or reply box to add a GIF'
      : '';

    gridEl.textContent = '';
    if (favorites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tgf-empty';
      empty.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">${PANEL_ICONS.star}</svg><strong>No favorite GIFs yet</strong>Click the ⭐ in the corner of any GIF to save it here.`;
      gridEl.appendChild(empty);
      return;
    }
    favorites.forEach((entry) => gridEl.appendChild(buildPanelItem(entry)));
  }

  // ---------- Startup ----------
  function init() {
    applyTheme();
    new MutationObserver(applyTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    buildPanel();

    try {
      const moved = migrateLegacyFavorites();
      if (moved) {
        console.log(`[TGF] Migrated ${moved} favorites to the v3 storage format`);
        toast(`Favorites upgraded to the new storage format (${moved} GIFs kept) ✅`, 4000);
      }
    } catch (err) {
      console.error('[TGF] Migration failed, old data left untouched:', err);
    }

    // Another tab changed the favorites: refresh our in-memory index, stars and panel.
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(INDEX_KEY, (name, oldValue, newValue, remote) => {
        if (!remote) return;
        reloadIndex();
        refreshStars();
        renderPanel();
      });
    }

    scanForGifs(document);
    scanForToolbars(document);

    let debounce;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        scanForGifs(document);
        scanForToolbars(document);
        followAnchor();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    GM_registerMenuCommand('View my favorite GIFs', () => openPanel(null, null));
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 800);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
  }
})();
