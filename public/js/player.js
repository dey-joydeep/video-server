import { renderCards, initCardEventListeners } from './card.js';
import { attachSpritePreview } from './sprite-preview.js';
import { state } from './state.js';
import './plugins/seek-buttons.js';
import {
  startSession,
  waitForReadySSE,
  pollUntilReady,
} from './services/session.js';

const videojs = window.videojs;

const playerElement = document.getElementById('v');
const listEl = document.getElementById('list');
const loadMoreBtn = document.getElementById('moreMore');
const loadingOverlay = document.getElementById('loading-overlay');

let player;
let relatedItems = [];
let relatedPage = 0;
const relatedPageSize = 14;
let firstPlayableReached = false;
let spinnerVisible = false;
let spinnerVisibleAt = 0;
let spinnerShowTimer = null;
let spinnerHideTimer = null;
const SPINNER_SHOW_DELAY_MS = 150;
const SPINNER_MIN_VISIBLE_MS = 350;
let playlistRetryAttempts = 0;
const MAX_PLAYLIST_RETRIES = 5;
let currentSessionToken = null;
let currentHlsUrl = null;

function getId() {
  const u = new URL(window.location.href);
  return u.searchParams.get('id');
}

function toggleLoading(show) {
  if (!loadingOverlay) return;
  if (show) {
    loadingOverlay.classList.remove('hidden');
  } else {
    loadingOverlay.classList.add('hidden');
  }
}

function showSpinnerNow() {
  if (spinnerHideTimer) {
    clearTimeout(spinnerHideTimer);
    spinnerHideTimer = null;
  }
  spinnerVisible = true;
  spinnerVisibleAt = Date.now();
  toggleLoading(true);
}

function hideSpinnerNow() {
  spinnerVisible = false;
  spinnerVisibleAt = 0;
  toggleLoading(false);
}

function requestSpinnerShow(immediate = false) {
  if (spinnerVisible) return;
  if (spinnerShowTimer) return;
  if (immediate) {
    showSpinnerNow();
    return;
  }
  spinnerShowTimer = setTimeout(() => {
    spinnerShowTimer = null;
    showSpinnerNow();
  }, SPINNER_SHOW_DELAY_MS);
}

function requestSpinnerHide() {
  if (spinnerShowTimer) {
    clearTimeout(spinnerShowTimer);
    spinnerShowTimer = null;
  }
  if (!spinnerVisible) return;
  const elapsed = Date.now() - spinnerVisibleAt;
  if (elapsed >= SPINNER_MIN_VISIBLE_MS) {
    hideSpinnerNow();
  } else {
    if (spinnerHideTimer) return;
    spinnerHideTimer = setTimeout(() => {
      spinnerHideTimer = null;
      hideSpinnerNow();
    }, SPINNER_MIN_VISIBLE_MS - elapsed);
  }
}

function renderRelated() {
  const start = relatedPage * relatedPageSize;
  const slice = relatedItems.slice(0, start + relatedPageSize);
  renderCards(listEl, slice);
  if (loadMoreBtn) {
    loadMoreBtn.style.display =
      slice.length >= relatedItems.length ? 'none' : 'block';
  }
}

async function loadRelated(excludeId) {
  try {
    const res = await fetch('/api/list?limit=1000&offset=0', {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('list failed');
    const data = await res.json();
    relatedItems = (data.items || data).filter((x) => x.id !== excludeId);
    state.items = relatedItems;
    renderRelated();
  } catch (e) {
    console.warn('Related list error', e);
  }
}

async function pollSessionStatus(token, onTick) {
  const pollInterval = 2000;
  return new Promise((resolve, reject) => {
    const intervalId = setInterval(async () => {
      try {
        const res = await fetch(`/api/session/status?token=${token}`);
        if (!res.ok) {
          clearInterval(intervalId);
          reject(new Error(`Status check failed: ${res.statusText}`));
          return;
        }
        const data = await res.json();
        if (typeof onTick === 'function') onTick(data);
        if (data.status === 'ready') {
          clearInterval(intervalId);
          resolve(data);
        } else if (data.status === 'error') {
          clearInterval(intervalId);
          reject(new Error('Video processing failed.'));
        }
      } catch (err) {
        clearInterval(intervalId);
        reject(err);
      }
    }, pollInterval);
  });
}

// superseded by services/session.js

async function fetchMetadata(id) {
  try {
    const metaRes = await fetch(`/api/meta?id=${id}`);
    if (!metaRes.ok) throw new Error('meta failed');
    return await metaRes.json();
  } catch (e) {
    console.warn('Could not fetch video metadata', e);
    return null;
  }
}

function formatDuration(seconds) {
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function updateMetaDisplay(meta) {
  if (!meta) return;
  const container = document.querySelector('.player');
  if (!container) return;
  const durationDisplay = container.querySelector('.meta-duration');
  if (meta.durationMs && durationDisplay) {
    durationDisplay.textContent = formatDuration(meta.durationMs / 1000);
  }
}

function isTimeBuffered(p, t) {
  try {
    const r = p.buffered();
    const fudge = 0.25;
    for (let i = 0; i < r.length; i += 1) {
      const start = r.start(i) - fudge;
      const end = r.end(i) + fudge;
      if (t >= start && t <= end) return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

function initVideoJs(meta) {
  if (!playerElement || !videojs) throw new Error('Video.js not available');
  player = videojs(playerElement, {
    controls: true,
    autoplay: false,
    preload: 'auto',
    fluid: true,
    liveui: false,
    controlBar: {
      playToggle: true,
      progressControl: true,
      volumePanel: true,
      fullscreenToggle: true,
      remainingTimeDisplay: false,
    },
    html5: {
      vhs: {
        overrideNative: !videojs.browser.IS_SAFARI,
        withCredentials: false,
      },
    },
  });

  player.ready(() => {
    if (typeof player.hotkeys === 'function') {
      player.hotkeys({
        volumeStep: 0.05,
        seekStep: 10,
        enableModifiersForNumbers: false,
        fullscreenKey: (e) => e.key === 'f' || e.key === 'F',
      });
    }
    if (typeof player.seekButtons === 'function') {
      player.seekButtons({ back: 10, forward: 10 });
    }
    // Ensure we start from the beginning once metadata is ready
    player.one('loadedmetadata', () => {
      try {
        if ((player.duration() || 0) > 0) player.currentTime(0);
      } catch {}
    });
  });

  player.on('waiting', () => {
    // show spinner when playback stalls, debounced
    requestSpinnerShow(false);
  });
  const markPlayable = () => {
    if (!firstPlayableReached) {
      firstPlayableReached = true;
      requestSpinnerHide();
    }
  };
  player.on('canplay', markPlayable);
  player.on('playing', markPlayable);
  player.on('seeking', () => {
    const t = player.currentTime();
    if (!isTimeBuffered(player, t)) requestSpinnerShow(false);
  });
  player.on('seeked', () => {
    if (firstPlayableReached) requestSpinnerHide();
  });
  // timeupdate hide guard for quick resume
  player.on('timeupdate', () => {
    if (spinnerVisible) requestSpinnerHide();
  });
  player.on('error', () => requestSpinnerHide());
  // Retry playlist fetch a few times if early 404/unsupported occurs
  player.on('error', () => {
    const err = typeof player.error === 'function' ? player.error() : null;
    if (!currentHlsUrl || playlistRetryAttempts >= MAX_PLAYLIST_RETRIES) return;
    const shouldRetry = err && (err.code === 2 || err.code === 4);
    if (!shouldRetry) return;
    playlistRetryAttempts += 1;
    requestSpinnerShow(false);
    setTimeout(() => {
      player.src({ src: currentHlsUrl, type: 'application/x-mpegURL' });
    }, 800);
  });

  updateMetaDisplay(meta);

  // Hook sprite preview once we know sprite VTT and player can play
  if (meta && meta.sprite) {
    const enablePreview = () => attachSpritePreview(player, meta.sprite);
    if (player.readyState && player.readyState() >= 2) {
      enablePreview();
    } else {
      player.one('canplay', enablePreview);
    }
  }
}

async function initialisePlayback(id) {
  const session = await startSession(id);
  let hlsUrl = session.hlsUrl;
  const token = session.token || null;
  // Avoid early 404s: wait for ready (with cap), then attach
  if (!hlsUrl && token && session.status === 'processing') {
    requestSpinnerShow(false);
    try {
      // Wait indefinitely for ready; do not attach early
      const ready = await waitForReadySSE(token, { timeoutMs: 0 });
      if (ready && ready.hlsUrl) hlsUrl = ready.hlsUrl;
    } catch {
      // Strict wait-then-attach: do not attach early
      try {
        const ready2 = await pollUntilReady(token, {
          intervalMs: 500,
          maxMs: 20000,
        });
        if (ready2 && ready2.hlsUrl) hlsUrl = ready2.hlsUrl;
      } catch {
        // give up gracefully
      }
    }
  }
  // Only attach when we have a confirmed servable playlist
  if (!hlsUrl) {
    console.error('Unable to prepare video: missing HLS URL after waiting');
    requestSpinnerHide();
    return;
  }
  currentSessionToken = token;
  currentHlsUrl = hlsUrl;
  playlistRetryAttempts = 0;
  player.src({ src: currentHlsUrl, type: 'application/x-mpegURL' });
  requestSpinnerHide();
}

(function bootstrap() {
  const id = getId();
  if (!id) {
    alert('Missing id');
    return;
  }

  // initial spinner (no debounce)
  requestSpinnerShow(true);
  initCardEventListeners(listEl, state);
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      relatedPage += 1;
      renderRelated();
    });
  }

  loadRelated(id);
  let started = false;
  fetchMetadata(id).then((meta) => {
    initVideoJs(meta);
    if (started) return;
    started = true;
    initialisePlayback(id).catch((err) => {
      // Soft-fail: log and keep spinner, do not crash
      console.warn('Playback initialisation deferred', err?.message || err);
    });
  });
})();
