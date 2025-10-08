import { renderCards, initCardEventListeners } from './card.js';
import { state } from './state.js';

const video = document.getElementById('v');
const listEl = document.getElementById('list');
const loadEl = document.getElementById('loading');

let hls = null; // active Hls.js instance
let pendingController = null; // AbortController for in-flight /api/session

// --- loading helpers ---
function showLoading(msg) {
  if (loadEl) {
    loadEl.textContent = msg || 'Loading…';
    loadEl.classList.remove('hidden');
  }
}
function hideLoading() {
  if (loadEl) loadEl.classList.add('hidden');
}

// Initial UI hint
showLoading('Preparing video…');

// --- util ---
function getId() {
  const u = new URL(location.href);
  return u.searchParams.get('id');
}

// --- cleanup to prevent "listener disconnected" and leaks ---
function cleanup() {
  // abort any in-flight session fetch
  try {
    pendingController?.abort();
  } catch {
    /* Ignored */
  }
  pendingController = null;

  // destroy Hls.js cleanly
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* Ignored */
    }
    hls = null;
  }

  // fully detach media
  if (video) {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* Ignored */
    }
  }
}
window.addEventListener('pagehide', cleanup);
window.addEventListener('beforeunload', cleanup);

// --- keyboard shortcuts ---
function bindKeys() {
  // ensure video can take focus so arrow keys work after button clicks
  if (video && !video.hasAttribute('tabindex'))
    video.setAttribute('tabindex', '0');

  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      video.currentTime = Math.min(
        video.duration || 1,
        (video.currentTime || 0) + 5
      );
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      video.currentTime = Math.max(0, (video.currentTime || 0) - 5);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      video.volume = Math.min(1, (video.volume ?? 0) + 0.05);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      video.volume = Math.max(0, (video.volume ?? 0) - 0.05);
    }
  });
}

// --- playback ---
async function play(id) {
  cleanup(); // make sure previous session/HLS are gone

  // lock down a few capabilities (best-effort)
  video.setAttribute('disablepictureinpicture', '');
  video.setAttribute('controlslist', 'noplaybackrate nodownload');
  showLoading('Preparing the video…');

  // start session with abortability
  pendingController = new AbortController();
  let hlsUrl;
  try {
    const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: pendingController.signal,
    });
    if (!res.ok) throw new Error('Failed to start session');
    const js = await res.json();
    hlsUrl = js.hlsUrl;
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Session error:', e);
      alert('Failed to start session');
    }
    return;
  } finally {
    // this controller belongs only to /api/session; clear now
    pendingController = null;
  }

  showLoading('Attaching stream…');

  // native HLS (Safari) path
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = hlsUrl;

    const onReady = () => {
      hideLoading();
    };
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
    video.addEventListener(
      'error',
      () => {
        console.warn('Video error (native)');
        hideLoading();
      },
      { once: true }
    );
    return;
  }

  // Hls.js path (Chrome/Firefox/Edge)
  if (window.Hls && window.Hls.isSupported()) {
    // Create once per playback
    hls = new Hls({
      lowLatencyMode: false,
      enableWorker: true,
    });

    // Attach lifecycle handlers to avoid “listener disconnected” races
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideLoading();
    });

    hls.on(Hls.Events.ERROR, (_ev, data) => {
      console.warn('Hls.js error:', data);
      if (!data?.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          try {
            hls.startLoad();
          } catch {
            /* Ignored */
          }
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          try {
            hls.recoverMediaError();
          } catch {
            /* Ignored */
          }
          break;
        default:
          // unrecoverable — reset and notify
          cleanup();
          showLoading('Playback error. Please retry.');
          break;
      }
    });

    hls.attachMedia(video);
    hls.loadSource(hlsUrl);
    return;
  }

  // no support
  hideLoading();
  alert('Your browser cannot play secure HLS.');
}

// --- “More videos” list (load early to improve perceived performance) ---
const loadMoreBtn = document.getElementById('moreMore');

let relatedItems = [];
let relatedPage = 0;
const relatedPageSize = 14;

function renderRelated() {
  const start = relatedPage * relatedPageSize;
  const slice = relatedItems.slice(0, start + relatedPageSize);
  renderCards(listEl, slice);
  loadMoreBtn.style.display =
    slice.length >= relatedItems.length ? 'none' : 'block';
}

async function loadRelated(excludeId) {
  try {
    const res = await fetch('/api/list?limit=1000&offset=0', {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('list failed');
    const data = await res.json();

    relatedItems = (data.items || data).filter((x) => x.id !== excludeId);
    state.items = relatedItems; // for card.js
    renderRelated();
  } catch (e) {
    console.warn('Related list error:', e);
  }
}

loadMoreBtn.addEventListener('click', () => {
  relatedPage++;
  renderRelated();
});

const previewEl = document.querySelector('.progress-bar-preview');
const previewThumbEl = document.querySelector('.preview-thumb');
const previewTimeEl = document.querySelector('.preview-time');
let vttCues = [];

// --- VTT & Sprite Preview Logic ---
async function initSpritePreview(vttUrl) {
  try {
    const res = await fetch(vttUrl);
    if (!res.ok) return;
    const text = await res.text();
    vttCues = parseVtt(text);
    if (vttCues.length > 0) {
      video.addEventListener('mousemove', onProgressMouseMove);
      video.addEventListener('mouseleave', onProgressMouseLeave);
    }
  } catch (e) {
    console.warn('Failed to load sprite preview', e);
  }
}

function parseVtt(text) {
  const lines = text.trim().split(/\r?\n/);
  const cues = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].includes('-->')) {
      const [start, end] = lines[i].split(' --> ').map(timeToSeconds);
      const urlLine = lines[++i];
      const match = urlLine.match(/(.+?)#xywh=(\d+),(\d+),(\d+),(\d+)/);
      if (match) {
        cues.push({
          start,
          end,
          url: `/thumbs/${match[1]}`,
          x: parseInt(match[2], 10),
          y: parseInt(match[3], 10),
          w: parseInt(match[4], 10),
          h: parseInt(match[5], 10),
        });
      }
    }
  }
  return cues;
}

function timeToSeconds(timeStr) {
  const parts = timeStr.split(':');
  const seconds = parts.pop();
  return (
    parseInt(parts[0], 10) * 3600 +
    parseInt(parts[1], 10) * 60 +
    parseFloat(seconds)
  );
}

function secondsToTime(time) {
  const m = Math.floor(time / 60);
  const s = Math.floor(time % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function onProgressMouseMove(e) {
  if (!video.duration || vttCues.length === 0) return;

  const rect = video.getBoundingClientRect();
  const percent = (e.clientX - rect.left) / rect.width;
  const hoverTime = video.duration * percent;

  const cue = vttCues.find((c) => hoverTime >= c.start && hoverTime < c.end);
  if (!cue) {
    previewEl.classList.remove('visible');
    return;
  }

  previewThumbEl.style.backgroundImage = `url(${cue.url})`;
  previewThumbEl.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
  previewThumbEl.style.width = `${cue.w}px`;
  previewThumbEl.style.height = `${cue.h}px`;
  previewTimeEl.textContent = secondsToTime(hoverTime);

  // Position the preview box
  const previewWidth = previewEl.offsetWidth;
  let previewLeft = e.clientX - rect.left - previewWidth / 2;
  // Clamp to video bounds
  previewLeft = Math.max(0, Math.min(previewLeft, rect.width - previewWidth));

  previewEl.style.left = `${previewLeft}px`;
  previewEl.classList.add('visible');
}

function onProgressMouseLeave() {
  previewEl.classList.remove('visible');
}

// --- bootstrap ---
(async () => {
  const id = getId();
  if (!id) {
    alert('Missing id');
    return;
  }

  bindKeys();
  initCardEventListeners(listEl, state);

  // Fetch metadata to check for sprites
  try {
    const metaRes = await fetch(`/api/meta?id=${id}`);
    const meta = await metaRes.json();
    if (meta.sprite) {
      initSpritePreview(meta.sprite);
    }
  } catch (e) {
    console.warn('Could not fetch video metadata', e);
  }

  // Start “More videos” early to improve perceived responsiveness:
  // don’t await it — let it render as soon as it returns.
  loadRelated(id);

  // Then attach playback
  await play(id);

  // Additional safety: hide loading once video is ready
  video.addEventListener('canplay', hideLoading, { once: true });
  video.addEventListener('loadeddata', hideLoading, { once: true });
})();
