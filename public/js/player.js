// player.js — responsive loading + robust HLS cleanup
// Implements: loading states, parallel "more videos" load, and clean teardown to fix
// intermittent "listener disconnected" errors in hls.js.

const video = document.getElementById('v');
const moreList = document.getElementById('moreList');
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
    } catch {}
    pendingController = null;

    // destroy Hls.js cleanly
    if (hls) {
        try {
            hls.destroy();
        } catch {}
        hls = null;
    }

    // fully detach media
    if (video) {
        try {
            video.pause();
            video.removeAttribute('src');
            video.load();
        } catch {}
    }
}

// Clean up on tab lifecycle
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
            video.play().catch(() => {});
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
            video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_ev, data) => {
            console.warn('Hls.js error:', data);
            if (!data?.fatal) return;
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    try {
                        hls.startLoad();
                    } catch {}
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    try {
                        hls.recoverMediaError();
                    } catch {}
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
async function loadMoreList(excludeId) {
    try {
        // hint while loading related content
        const holder = document.getElementById('moreHolder');
        if (holder && holder.classList.contains('hidden')) {
            holder.classList.remove('hidden');
        }

        const res = await fetch('/api/list?limit=1000&offset=0', {
            cache: 'no-store',
        });
        if (!res.ok) throw new Error('list failed');
        const data = await res.json();

        const items = (data.items || data)
            .filter((x) => x.id !== excludeId)
            .slice(0, 14);

        moreList.innerHTML = items
            .map(
                (it) => `
      <div class="card" data-id="${it.id}" data-name="${it.name}"
           tabindex="0" role="button" aria-label="Open ${it.name}">
        <img class="thumb" src="/thumbs/${it.thumb}" alt="${it.name}">
        <div class="title">${it.name}</div>
        <div class="meta">${new Date(it.mtimeMs).toLocaleString()}</div>
      </div>`
            )
            .join('');

        // Single handler to avoid flicker / double init
        const handleOpen = (nid) => {
            showLoading('Loading video…');
            history.replaceState(
                null,
                '',
                './player.html?id=' + encodeURIComponent(nid)
            );
            play(nid);
            // refresh list in background
            loadMoreList(nid);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };

        moreList.querySelectorAll('.card').forEach((card) => {
            const nid = card.dataset.id;
            const open = () => handleOpen(nid);
            card.addEventListener('click', open);
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                }
            });
        });
    } catch (e) {
        console.warn('Related list error:', e);
    }
}

// --- bootstrap ---
(async () => {
    const id = getId();
    if (!id) {
        alert('Missing id');
        return;
    }

    bindKeys();

    // Start “More videos” early to improve perceived responsiveness:
    // don’t await it — let it render as soon as it returns.
    loadMoreList(id);

    // Then attach playback
    await play(id);

    // Additional safety: hide loading once video is ready
    video.addEventListener('canplay', hideLoading, { once: true });
    video.addEventListener('loadeddata', hideLoading, { once: true });
})();
