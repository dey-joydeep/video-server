import { state, loadPrefs, savePrefs } from './state.js';
import { cardHtml } from './components.js';

const listEl = document.getElementById('list');
const loadMoreEl = document.getElementById('loadMore');
const qEl = document.getElementById('q');
const sortEl = document.getElementById('sort');
const toggleViewEl = document.getElementById('toggleView');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const prefPreview = document.getElementById('prefPreview');
const prefVolume = document.getElementById('prefVolume');
const closeSettings = document.getElementById('closeSettings');

loadPrefs();
prefPreview.checked = state.prefs.preview;
prefVolume.value = state.prefs.volume;

if (state.isMobile) {
    toggleViewEl.classList.remove('hidden');
    state.pageSize = 12;
} else {
    toggleViewEl.classList.add('hidden');
    state.pageSize = 21;
}

function fmtSort(a, b, sort) {
    if (sort === 'name-asc') return a.name.localeCompare(b.name);
    if (sort === 'name-desc') return b.name.localeCompare(a.name);
    if (sort === 'date-asc') return a.mtimeMs - b.mtimeMs;
    if (sort === 'date-desc') return b.mtimeMs - a.mtimeMs;
    return 0;
}

let all = { total: 0, items: [] };

async function fetchPage(reset = false) {
    if (reset) {
        state.page = 0;
        listEl.innerHTML = '';
    }
    const res = await fetch(
        `/api/list?limit=1000&offset=0&q=${encodeURIComponent(qEl.value)}`
    );
    all = await res.json();
    const items = (all.items || all).sort((a, b) =>
        fmtSort(a, b, sortEl.value)
    );
    state.items = items;
    render();
}

function render() {
    const start = state.page * state.pageSize;
    const slice = state.items.slice(0, start + state.pageSize);
    listEl.innerHTML = slice.map(cardHtml).join('');
    loadMoreEl.disabled = slice.length >= state.items.length;
    bindCards();
}

function bindCards() {
    listEl.querySelectorAll('.card').forEach((card) => {
        const id = card.dataset.id;
        const img = card.querySelector('.thumb');

        let previewTimer = null;
        let hls = null;
        let vid = null;

        const cleanup = () => {
            if (vid) {
                try {
                    vid.pause();
                } catch {}
                vid.remove();
                vid = null;
            }
            if (hls) {
                try {
                    hls.destroy();
                } catch {}
                hls = null;
            }
            if (!img.isConnected) {
                card.insertBefore(img, card.firstChild);
            }
        };

        const startPreview = async () => {
            if (!state.prefs.preview) return;
            if (vid) return;
            try {
                const r = await fetch(
                    '/api/session?id=' + encodeURIComponent(id)
                );
                if (!r.ok) return;
                const { hlsUrl } = await r.json();
                vid = document.createElement('video');
                vid.muted = true;
                vid.playsInline = true;
                vid.autoplay = true;
                vid.controls = false;
                vid.volume = parseFloat(prefVolume.value || '0');
                vid.style.width = '100%';
                vid.style.borderRadius = '10px';

                if (vid.canPlayType('application/vnd.apple.mpegurl')) {
                    vid.src = hlsUrl;
                } else if (window.Hls && window.Hls.isSupported()) {
                    const _hls = new Hls();
                    _hls.loadSource(hlsUrl);
                    _hls.attachMedia(vid);
                    hls = _hls;
                } else {
                    return;
                }

                img.replaceWith(vid);

                // Add a simple loop to seek to a random position
                const jump = () => {
                    if (vid && vid.duration && isFinite(vid.duration)) {
                        let max = Math.max(0, vid.duration - 3);
                        let t = Math.random() * max;
                        if (t < 0) t = 0;
                        vid.currentTime = t;
                    }
                };
                const previewInterval = setInterval(jump, 3000);
                vid.addEventListener('pause', () => clearInterval(previewInterval), { once: true });

            } catch (e) {
                console.error("Preview failed", e);
                cleanup();
            }
        };

        const cancelPreview = () => {
            clearTimeout(previewTimer);
            previewTimer = null;
            cleanup();
        };

        if (!state.isMobile) {
            // Mouse events for desktop devices
            card.addEventListener('mouseenter', () => {
                previewTimer = setTimeout(startPreview, 250);
            });
            card.addEventListener('mouseleave', cancelPreview);
        }

        if (state.isTouch) {
            // Touch events for touch-enabled devices
            card.addEventListener('touchstart', (e) => {
                e.preventDefault(); // Prevent click event from firing immediately
                previewTimer = setTimeout(startPreview, 250);
            });
            card.addEventListener('touchend', cancelPreview);
            card.addEventListener('touchcancel', cancelPreview);
        }

        const open = () => {
            location.href = `./player.html?id=${encodeURIComponent(id)}`;
        };
        card.addEventListener('click', (e) => {
            e.preventDefault();
            open();
        });
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });

        card.querySelector('.title')?.classList.add('pointer');
        img?.classList.add('pointer');
    });
}

qEl.addEventListener('input', () => fetchPage(true));
sortEl.addEventListener('change', () => fetchPage(true));
document.getElementById('loadMore').addEventListener('click', () => {
    state.page++;
    render();
});

toggleViewEl.addEventListener('click', () => {
    if (listEl.classList.contains('grid')) {
        listEl.classList.remove('grid');
        listEl.classList.add('list');
    } else {
        listEl.classList.remove('list');
        listEl.classList.add('grid');
    }
});

settingsBtn.addEventListener('click', () =>
    settingsModal.classList.add('show')
);
document
    .getElementById('closeSettings')
    .addEventListener('click', () => settingsModal.classList.remove('show'));
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.remove('show');
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') settingsModal.classList.remove('show');
});

prefPreview.addEventListener('change', () => {
    state.prefs.preview = prefPreview.checked;
    savePrefs();
});
prefVolume.addEventListener('input', () => {
    state.prefs.volume = parseFloat(prefVolume.value || '0');
    savePrefs();
});

fetchPage(true);
