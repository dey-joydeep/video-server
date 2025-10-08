import { state, loadPrefs } from './state.js';
import { renderCards, initCardEventListeners } from './card.js';

import { initSettingsModal } from '../components/settings-modal/settings-modal.js';

const listEl = document.getElementById('list');
const loadMoreEl = document.getElementById('loadMore');
const qEl = document.getElementById('q');
const sortEl = document.getElementById('sort');
const toggleViewEl = document.getElementById('toggleView');

loadPrefs();

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
  const items = (all.items || all).sort((a, b) => fmtSort(a, b, sortEl.value));
  state.items = items;
  render();
}

function render() {
  const start = state.page * state.pageSize;
  const slice = state.items.slice(0, start + state.pageSize);
  renderCards(listEl, slice);
  loadMoreEl.style.display =
    slice.length >= state.items.length ? 'none' : 'block';
}

initCardEventListeners(listEl, state);
initSettingsModal();

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

fetchPage(true);
