/**
 * @fileoverview Main logic for the video player page.
 * This script handles:
 * - Initializing the Video.js player.
 * - Fetching video metadata and related videos.
 * - Managing HLS session initialization and recovery.
 * - Proactive error handling for deleted videos and expired sessions.
 * - Spinner and loading UI management.
 */

import { renderCards, initCardEventListeners } from './card.js';
import { attachSpritePreview } from './sprite-preview.js';
import { state } from './state.js';

import {
  startSession,
  waitForReadySSE,
  pollUntilReady,
} from './services/session.js';

// --- DOM Elements ---
const videojs = window.videojs;
const playerElement = document.getElementById('v');
const listEl = document.getElementById('list');
const loadMoreBtn = document.getElementById('moreMore');

// --- Player State ---
let player;
let relatedItems = [];
let relatedPage = 0;
const relatedPageSize = 14;
let firstPlayableReached = false;
let playlistRetryAttempts = 0;
const MAX_PLAYLIST_RETRIES = 5;
let currentHlsUrl = null;

/**
 * A centralized store for user-facing error messages.
 */
const MSG = Object.freeze({
  ERR: {
    VIDEO_UNAVAILABLE: 'This video is no longer available.',
    SESSION_RECOVERY_FAILED: 'Could not recover session. Please reload.',
    STREAM_UNAVAILABLE:
      'Playback failed because the video stream has become unavailable.',
    LOAD_FAILED: 'Could not load video.',
  },
});

/**
 * A centralized function to display a playback error to the user.
 * It resets the player to clear the last frame before showing the error message.
 * @param {string} message The error message to display.
 */
function showPlaybackError(message) {
  player.reset(); // Reset the player to clear the last frame and stop playback
  player.error({ code: 10, message }); // Use a custom error code
}

/**
 * A centralized function to handle HLS session expiration.
 * It requests a new session and then attempts to restart playback.
 */
async function handleExpiredSession() {
  console.warn('HLS session expired. Requesting a new session...');
  const id = getId();
  const currentTime = player.currentTime(); // Store current time
  try {
    await initialisePlayback(id);
    // Wait for the new source to be loaded before seeking and playing
    player.one('loadedmetadata', () => {
      player.currentTime(currentTime);
      player.play();
    });
  } catch (e) {
    console.error('Failed to recover HLS session:', e);
    showPlaybackError(MSG.ERR.SESSION_RECOVERY_FAILED);
  }
}

/**
 * Gets the video ID from the URL query string.
 * @returns {string|null} The video ID.
 */
function getId() {
  const u = new URL(window.location.href);
  return u.searchParams.get('id');
}

// --- Data Loading and Rendering ---

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

// --- Player Logic ---

/**
 * Proactively checks if a video source URL is valid by making a HEAD request.
 * This is used to quickly detect deleted videos (404) or expired sessions (403).
 * @param {string} url The URL of the HLS playlist to validate.
 * @returns {Promise<number>} The HTTP status code of the response (e.g., 200, 403, 404).
 * Returns 0 if a network error occurs.
 */
async function validateVideoSource(url) {
  if (!url) return 400; // Or some other client error code
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return res.status;
  } catch (e) {
    console.warn('Source validation check failed', e);
    // Be lenient on network errors, allow player to handle it
    return 0; // Special code for network error
  }
}

/**
 * Initializes the Video.js player and sets up all event listeners.
 * @param {object} meta The video metadata.
 */
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
        'progressControl',
        'playToggle',
        'volumePanel',
        'currentTimeDisplay',
        'timeDivider',
        'durationDisplay',
        'skipBackward',
        'skipForward',
        'spacer',
        'playbackRateMenuButton',
        'pictureInPictureToggle',
        'fullscreenToggle',
      ],
      progressControl: { keepTooltipsInside: true },
      volumePanel: { inline: true },
      skipButtons: {
        forward: 10,
        backward: 10,
      },
    },
    playbackRates: [0.5, 1, 1.5, 2],
    html5: {
      nativeAudioTracks: false,
      nativeVideoTracks: false,
      vhs: {
        overrideNative: !videojs.browser.IS_SAFARI,
        withCredentials: false,
        enableLowInitialPlaylist: true,
        cacheEncryptionKeys: true,
      },
    },
  });

  player.ready(() => {
    try {
      if (typeof player.aspectRatio === 'function') player.aspectRatio('16:9');
    } catch {
      void 0;
    }
    if (typeof player.hotkeys === 'function') {
      player.hotkeys({
        volumeStep: 0.05,
        seekStep: 10,
        enableModifiersForNumbers: false,
        fullscreenKey: (e) => e.key === 'f' || e.key === 'F',
      });
    }

    player.one('loadedmetadata', () => {
      try {
        if ((player.duration() || 0) > 0) player.currentTime(0);
      } catch {
        void 0;
      }
    });
  });

  // --- Player Event Handlers ---

  const markPlayable = () => {
    if (!firstPlayableReached) {
      firstPlayableReached = true;
    }
  };
  player.on('canplay', markPlayable);
  player.on('playing', markPlayable);

  /**
   * On resume, proactively re-validate the HLS source. This handles cases where
   * the video was deleted or the session expired while the player was paused.
   */
  player.on('play', async () => {
    // Only validate after the first play event and if there is a source.
    if (firstPlayableReached && player.src()) {
      const validationStatus = await validateVideoSource(player.src());

      if (validationStatus === 200) {
        // Source is valid, do nothing.
        return;
      }

      // Stop the player immediately if the source is not valid.
      player.pause();

      if (validationStatus === 403) {
        handleExpiredSession();
      } else if (validationStatus === 404) {
        // Video is no longer available (deleted).
        showPlaybackError(MSG.ERR.VIDEO_UNAVAILABLE);
      }
      // Other statuses (e.g., network errors) are allowed to be handled by the
      // main player error handler.
    }
  });

  /**
   * The main error handler for the player. This is a reactive handler for
   * unexpected errors that occur during playback.
   */
  player.on('error', () => {
    const err = typeof player.error === 'function' ? player.error() : null;
    if (!err) return;

    // Handle expired session (403 Forbidden) by re-initializing
    if (err.status === 403) {
      handleExpiredSession();
      return; // Stop further error processing
    }

    // If a segment is not found (e.g., deleted during playback), fail immediately.
    if (err.status === 404) {
      return showPlaybackError(MSG.ERR.STREAM_UNAVAILABLE);
    }

    // If retries are exhausted for other errors, show a final error message.
    if (playlistRetryAttempts >= MAX_PLAYLIST_RETRIES) {
      return showPlaybackError(MSG.ERR.STREAM_UNAVAILABLE);
    }

    // Retry logic for other specific, recoverable errors
    // This will not run for our custom error code 10.
    const shouldRetry = err.code === 2 || err.code === 4; // MEDIA_ERR_NETWORK | MEDIA_ERR_SRC_NOT_SUPPORTED
    if (!shouldRetry || !currentHlsUrl) return;

    playlistRetryAttempts += 1;
    console.warn(`Playlist error, retry #${playlistRetryAttempts}...`);
    setTimeout(() => {
      // Reload the same source with a cache-busting param.
      const newUrl = new URL(currentHlsUrl, window.location.href);
      newUrl.searchParams.set('_v', Date.now());
      player.src({ src: newUrl.href, type: 'application/x-mpegURL' });
    }, 800);
  });

  player.one('play', () => {
    try {
      const tooltip = player.el().querySelector('.vjs-time-tooltip');
      if (tooltip) {
        tooltip.remove();
      }
    } catch (e) {
      console.warn('Could not remove vjs-time-tooltip', e);
    }
  });

  if (meta && meta.sprite) {
    const enablePreview = () => attachSpritePreview(player, meta.sprite);
    if (player.readyState && player.readyState() >= 2) {
      enablePreview();
    } else {
      player.one('canplay', enablePreview);
    }
  }
}

/**
 * Initializes the entire playback sequence for a given video ID.
 * 1. Starts a session to get the HLS URL.
 * 2. Waits for the stream to be ready if it's still processing.
 * 3. Proactively validates the HLS URL.
 * 4. Sets the source on the player.
 * Catches errors at any stage and displays a user-friendly message.
 * @param {string} id The ID of the video to play.
 */
async function initialisePlayback(id) {
  try {
    // 1. Start a session.
    const session = await startSession(id);
    let hlsUrl = session.hlsUrl;
    const token = session.token || null;

    // 2. If the session is still processing, wait for it to be ready.
    if (!hlsUrl && token && session.status === 'processing') {
      try {
        // First, try waiting with Server-Sent Events.
        const ready = await waitForReadySSE(token, { timeoutMs: 0 });
        if (ready && ready.hlsUrl) hlsUrl = ready.hlsUrl;
      } catch {
        // As a fallback, poll the status endpoint.
        const ready2 = await pollUntilReady(token, {
          intervalMs: 500,
          maxMs: 20000,
        });
        if (ready2 && ready2.hlsUrl) hlsUrl = ready2.hlsUrl;
      }
    }

    // If we still don't have a URL, the video is unavailable.
    if (!hlsUrl) {
      return showPlaybackError(MSG.ERR.VIDEO_UNAVAILABLE);
    }

    // 3. Proactively validate the HLS playlist URL.
    const validationStatus = await validateVideoSource(hlsUrl);
    if (validationStatus !== 200) {
      // Handle 404 specifically. Other errors will be handled by the player.
      if (validationStatus === 404) {
        return showPlaybackError(MSG.ERR.VIDEO_UNAVAILABLE);
      }
    }

    // 4. Set the source on the player.
    currentHlsUrl = hlsUrl;
    playlistRetryAttempts = 0;
    player.src({ src: currentHlsUrl, type: 'application/x-mpegURL' });
  } catch (err) {
    // This catch block handles fatal errors, e.g., if startSession fails.
    console.error('Failed to initialise playback', err);
    const message =
      err.status === 404 ? MSG.ERR.VIDEO_UNAVAILABLE : MSG.ERR.LOAD_FAILED;
    showPlaybackError(message);
  }
}

/**
 * Bootstraps the player page.
 */
(function bootstrap() {
  const id = getId();
  if (!id) {
    alert('Missing id');
    return;
  }

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
      // Soft-fail: log and keep spinner, do not crash page.
      console.warn('Playback initialisation deferred', err?.message || err);
    });
  });
})();
