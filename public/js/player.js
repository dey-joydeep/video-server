import { renderCards, initCardEventListeners } from './card.js';
import { attachSpritePreview } from './sprite-preview.js';
import { state } from './state.js';
import './plugins/seek-buttons.js';
// default Video.js duration display
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

// (removed unused pollSessionStatus; SSE/polling handled in services/session.js)

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

// (duration display is handled by Video.js controlBar; no custom formatter)

function isTimeBuffered(p, t) {
  try {
    const r = p.buffered();
    const fudge = 0.25;
    for (let i = 0; i < r.length; i += 1) {
      const start = r.start(i) - fudge;
      const end = r.end(i) + fudge;
      if (t >= start && t <= end) return true;
    }
  } catch {
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
    inactivityTimeout: 0,
    controlBar: {
      children: [
        'playToggle',
        'currentTimeDisplay',
        'timeDivider',
        'durationDisplay',
        'progressControl',
        'volumePanel',
        'fullscreenToggle',
      ],
      volumePanel: { inline: true },
    },
    html5: {
      vhs: {
        overrideNative: !videojs.browser.IS_SAFARI,
        withCredentials: false,
      },
    },
  });

  player.ready(() => {
    // Pin aspect ratio so frame stays consistent regardless of source dimensions
    try {
      if (typeof player.aspectRatio === 'function') player.aspectRatio('16:9');
    } catch {
      void 0;
    }
    // Use standard Video.js time controls; no DOM manipulation
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
      } catch {
        void 0;
      }
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
