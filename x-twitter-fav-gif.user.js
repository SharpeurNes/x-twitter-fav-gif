// ==UserScript==
// @name         X/Twitter GIF Favorites
// @namespace    https://local/twitter-gif-favorites
// @version      1.5.0
// @description  Star GIFs on X/Twitter to save them as real, locally-stored .gif files, then repost them in one click from a button added to the tweet/reply toolbar.
// @author       SharpeurNes
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      video.twimg.com
// @connect      pbs.twimg.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @run-at       document-idle
// ==/UserScript==
// ==UserScript==
// @name         X/Twitter GIF Favorites
// @namespace    https://local/twitter-gif-favorites
// @version      1.4.0
// @description  Star GIFs on X/Twitter to save them as real, locally-stored .gif files, then repost them in one click from a button added to the tweet/reply toolbar.
// @author       You
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      video.twimg.com
// @connect      pbs.twimg.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'tgf_favorites_v2';
  const PROCESSED_ATTR = 'data-tgf-processed';
  const GIF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js';

  // MP4 -> GIF conversion settings
  const GIF_MAX_FRAMES = 90;
  const GIF_MAX_WIDTH = 480;
  const GIF_FPS = 12;
  const GIF_MAX_DURATION = 15; // seconds, safety cap

  // ---------- Storage ----------
  function getFavorites() {
    try {
      return JSON.parse(GM_getValue(STORAGE_KEY, '[]'));
    } catch (e) {
      return [];
    }
  }
  function saveFavorites(list) {
    GM_setValue(STORAGE_KEY, JSON.stringify(list));
  }
  function isFavorited(videoUrl) {
    return getFavorites().some((f) => f.videoUrl === videoUrl);
  }
  function addFavorite(item) {
    const list = getFavorites();
    if (list.some((f) => f.videoUrl === item.videoUrl)) return;
    list.unshift(item);
    saveFavorites(list);
  }
  function removeFavorite(videoUrl) {
    saveFavorites(getFavorites().filter((f) => f.videoUrl !== videoUrl));
  }

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
    } else {
      root.setProperty('--tgf-surface', 'rgba(255,255,255,0.9)');
      root.setProperty('--tgf-border', 'rgba(0,0,0,0.12)');
      root.setProperty('--tgf-panel-bg', '#ffffff');
      root.setProperty('--tgf-panel-border', '#eff3f4');
      root.setProperty('--tgf-text', '#0f1419');
      root.setProperty('--tgf-muted', '#536471');
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
      width: 320px;
      max-height: 480px;
      background: var(--tgf-panel-bg, #15202b);
      border: 1px solid var(--tgf-panel-border, #38444d);
      border-radius: 14px;
      display: none;
      flex-direction: column;
      overflow: hidden;
      font-family: Arial, sans-serif;
      color: var(--tgf-text, #e7e9ea);
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .tgf-panel.tgf-open { display: flex; }
    .tgf-panel-header {
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--tgf-panel-border, #38444d);
      font-size: 13px;
    }
    .tgf-panel-header strong { font-weight: 700; }
    .tgf-panel-header .tgf-count { color: var(--tgf-muted, #8b98a5); font-size: 11px; margin-right: auto; }
    .tgf-panel-header button {
      background: none; border: none; color: var(--tgf-muted, #8b98a5); cursor: pointer; font-size: 12px;
    }
    .tgf-panel-header .tgf-close { font-size: 16px; line-height: 1; padding: 2px 4px; }
    .tgf-grid {
      padding: 10px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      overflow-y: auto;
    }
    .tgf-empty {
      grid-column: 1 / -1;
      padding: 24px 14px;
      text-align: center;
      color: var(--tgf-muted, #8b98a5);
      font-size: 13px;
    }
    .tgf-item {
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      aspect-ratio: 1 / 1;
      cursor: pointer;
    }
    .tgf-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tgf-item .tgf-del {
      position: absolute; top: 2px; right: 2px;
      width: 20px; height: 20px; border-radius: 50%;
      background: rgba(0,0,0,0.7); color: white;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; border: none; cursor: pointer; z-index: 5;
    }
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

  // ---------- Network / file utilities ----------
  function fetchAsArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload: (res) => resolve(res.response),
        onerror: () => reject(new Error('network error')),
      });
    });
  }
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
  function isGifVideo(video) {
    if (video.loop) return true;
    const container = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (container) {
      const badge = Array.from(container.querySelectorAll('span, div')).find(
        (el) => el.childElementCount === 0 && el.textContent.trim() === 'GIF'
      );
      if (badge) return true;
    }
    return false;
  }

  function injectStar(video) {
    // Ignore anything the script created itself (previews, hidden conversion video)
    if (video.hasAttribute('data-tgf-own') || video.closest('.tgf-panel')) return;
    if (video.hasAttribute(PROCESSED_ATTR)) return;
    if (!isGifVideo(video)) return;
    video.setAttribute(PROCESSED_ATTR, '1');

    const container = video.closest('[data-testid="videoPlayer"]') || video.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const btn = document.createElement('button');
    btn.className = 'tgf-star-btn';
    btn.type = 'button';

    const refreshIcon = () => {
      const url = extractVideoUrl(video);
      btn.innerHTML = url && isFavorited(url) ? STAR_FILLED : STAR_OUTLINE;
    };
    refreshIcon();

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = extractVideoUrl(video);
      if (!url) {
        toast('GIF not loaded yet — let it play for a second, then try again ⭐');
        return;
      }

      if (isFavorited(url)) {
        removeFavorite(url);
        toast('GIF removed from favorites and deleted from local storage');
        refreshIcon();
        renderPanel();
        return;
      }

      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.innerHTML = STAR_LOADING;
      toast('Converting to GIF...', 60000);
      try {
        const buffer = await fetchAsArrayBuffer(url);
        const mp4Blob = new Blob([buffer], { type: 'video/mp4' });
        const gifBlob = await convertMp4BlobToGif(mp4Blob, (p) => {
          toast(`Converting to GIF... ${Math.round(Math.min(p, 1) * 100)}%`, 60000);
        });
        const gifDataUrl = await blobToDataUrl(gifBlob);
        const article = video.closest('article');
        addFavorite({
          videoUrl: url,
          gifDataUrl,
          sizeBytes: gifBlob.size,
          tweetUrl: article ? getTweetUrl(article) : '',
          addedAt: Date.now(),
        });
        toast('GIF converted and saved to favorites ⭐');
        renderPanel();
      } catch (err) {
        console.error('[TGF]', err);
        toast("Couldn't convert this GIF");
      } finally {
        btn.dataset.busy = '';
        refreshIcon();
      }
    });

    container.appendChild(btn);
  }

  function scanForGifs(root) {
    root.querySelectorAll('video').forEach(injectStar);
  }

  // ---------- Track the active compose box (fallback) ----------
  let lastComposer = null;
  let activeFileInput = null;
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
      activeFileInput = toolbar.querySelector('input[type="file"]');
      currentAnchor = toolbar;
      positionPanelNear(toolbar);
      panelEl.classList.add('tgf-open');
      renderPanel();
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

  // Positions the panel just above the toolbar, left-aligned, like X's native
  // emoji picker does (instead of a fixed spot on the page). Keeps track of the
  // anchor element so the panel can be repositioned again on scroll (see below).
  let currentAnchor = null;
  function positionPanelNear(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const width = 320;
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    panelEl.style.left = left + 'px';
    panelEl.style.right = 'auto';
    panelEl.style.top = 'auto';
    panelEl.style.bottom = window.innerHeight - rect.top + 8 + 'px';
  }

  // Keep the open panel glued to its anchor toolbar while the page (or the
  // reply/tweet modal, or the timeline) scrolls. `scroll` doesn't bubble, so the
  // listener is registered on the capture phase to catch it from any container.
  window.addEventListener(
    'scroll',
    () => {
      if (!panelEl || !panelEl.classList.contains('tgf-open')) return;
      if (!currentAnchor || !document.contains(currentAnchor)) return;
      positionPanelNear(currentAnchor);
    },
    true
  );
  window.addEventListener('resize', () => {
    if (!panelEl || !panelEl.classList.contains('tgf-open')) return;
    if (!currentAnchor || !document.contains(currentAnchor)) return;
    positionPanelNear(currentAnchor);
  });

  function attachFileToComposer(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function insertFavorite(item) {
    const input = findFileInput();
    if (!input) {
      toast('Open a tweet or reply box first 📝');
      return;
    }
    try {
      const blob = dataUrlToBlob(item.gifDataUrl);
      const file = new File([blob], `gif-${Date.now()}.gif`, { type: 'image/gif' });
      attachFileToComposer(input, file);
      toast('GIF added to the tweet ✅');
    } catch (err) {
      console.error('[TGF]', err);
      toast('Error inserting the GIF');
    }
  }

  // ---------- MP4 -> real animated GIF conversion ----------
  let workerBlobUrlPromise = null;
  function getWorkerBlobUrl() {
    if (!workerBlobUrlPromise) {
      workerBlobUrlPromise = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: GIF_WORKER_URL,
          onload: (res) => {
            const blob = new Blob([res.responseText], { type: 'application/javascript' });
            resolve(URL.createObjectURL(blob));
          },
          onerror: () => reject(new Error('worker fetch failed')),
        });
      });
    }
    return workerBlobUrlPromise;
  }

  function seekTo(video, time) {
    return new Promise((resolve) => {
      const handler = () => {
        video.removeEventListener('seeked', handler);
        resolve();
      };
      video.addEventListener('seeked', handler);
      video.currentTime = time;
    });
  }

  async function convertMp4BlobToGif(mp4Blob, onProgress) {
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
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
      });

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

      for (let i = 0; i < frameCount; i++) {
        const t = Math.min(duration - 0.02, i / fps);
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, width, height);
        gif.addFrame(ctx, { copy: true, delay: Math.round(1000 / fps) });
        if (onProgress) onProgress(0.1 + (i / frameCount) * 0.5);
      }

      const resultBlob = await new Promise((resolve, reject) => {
        gif.on('progress', (p) => onProgress && onProgress(0.6 + p * 0.4));
        gif.on('finished', (blob) => resolve(blob));
        try {
          gif.render();
        } catch (err) {
          reject(err);
        }
      });

      return resultBlob;
    } finally {
      video.remove();
      URL.revokeObjectURL(videoUrl);
    }
  }

  // ---------- Favorites panel ----------
  let panelEl, gridEl;

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'tgf-panel';
    panelEl.innerHTML = `
      <div class="tgf-panel-header">
        <strong>⭐ My GIFs</strong>
        <span class="tgf-count"></span>
        <button type="button" class="tgf-clear">Clear all</button>
        <button type="button" class="tgf-close" title="Close">✕</button>
      </div>
      <div class="tgf-grid"></div>
    `;
    document.body.appendChild(panelEl);
    gridEl = panelEl.querySelector('.tgf-grid');

    panelEl.querySelector('.tgf-close').addEventListener('click', () => {
      panelEl.classList.remove('tgf-open');
    });

    panelEl.querySelector('.tgf-clear').addEventListener('click', () => {
      if (confirm('Delete all favorite GIFs (and their locally stored files)?')) {
        saveFavorites([]);
        renderPanel();
      }
    });

    // Close the panel when clicking outside it (and outside the button that opens it)
    document.addEventListener('click', (e) => {
      if (!panelEl.classList.contains('tgf-open')) return;
      if (panelEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.tgf-toolbar-btn')) return;
      panelEl.classList.remove('tgf-open');
    });
  }

  function renderPanel() {
    if (!gridEl) return;
    const favorites = getFavorites();
    const countEl = panelEl.querySelector('.tgf-count');
    if (countEl) {
      const totalMb = favorites.reduce((s, f) => s + (f.sizeBytes || 0), 0) / (1024 * 1024);
      countEl.textContent = favorites.length ? `${favorites.length} · ${totalMb.toFixed(1)} MB` : '';
    }
    gridEl.innerHTML = '';
    if (favorites.length === 0) {
      gridEl.innerHTML =
        '<div class="tgf-empty">No favorite GIFs yet.<br>Click the star ⭐ on a GIF to convert and save it.</div>';
      return;
    }
    favorites.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'tgf-item';
      el.innerHTML = `
        <img src="${item.gifDataUrl}" data-tgf-own="1" alt="Favorite GIF">
        <button type="button" class="tgf-del" title="Remove">×</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tgf-del')) return;
        insertFavorite(item);
      });
      el.querySelector('.tgf-del').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFavorite(item.videoUrl);
        renderPanel();
      });
      gridEl.appendChild(el);
    });
  }

  // ---------- Startup ----------
  function init() {
    applyTheme();
    new MutationObserver(applyTheme).observe(document.body, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    buildPanel();
    scanForGifs(document);
    scanForToolbars(document);

    let debounce;
    const observer = new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        scanForGifs(document);
        scanForToolbars(document);
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    GM_registerMenuCommand('View my favorite GIFs', () => {
      panelEl.classList.add('tgf-open');
      renderPanel();
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 800);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
  }
})();
