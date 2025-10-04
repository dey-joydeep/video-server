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
        const previewClip = state.items.find(it => it.id === id)?.previewClip;

        let previewTimer = null;
        let videoEl = null;

        const startPreview = () => {
            if (!state.prefs.preview || !previewClip) return;

            const img = card.querySelector('.thumb');
            if (!img) return;

            videoEl = document.createElement('video');
            videoEl.classList.add('thumb');
            videoEl.src = previewClip;
            videoEl.muted = true;
            videoEl.loop = true;
            videoEl.playsInline = true;
            videoEl.autoplay = true;

            img.replaceWith(videoEl);
            videoEl.play().catch(e => console.warn("Preview play failed", e));
        };

        const cancelPreview = () => {
            clearTimeout(previewTimer);
            previewTimer = null;
            if (videoEl) {
                videoEl.pause();
                const img = new Image();
                img.src = `/thumbs/${id}.jpg`;
                img.classList.add('thumb');
                videoEl.replaceWith(img);
                videoEl = null;
            }
        };

        if (!state.isMobile) {
            card.addEventListener('mouseenter', () => {
                previewTimer = setTimeout(startPreview, 250);
            });
            card.addEventListener('mouseleave', cancelPreview);
        }

        if (state.isTouch) {
            card.addEventListener('touchstart', (e) => {
                e.preventDefault();
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
        card.querySelector('.thumb')?.classList.add('pointer');
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
