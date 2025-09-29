// public/js/main.js (v7)
import { getPrefs, setPref } from './state.js?v=7';
import { videoCard } from './components.js?v=7';

const $ = (s)=>document.querySelector(s);
const listEl = $('#list');
const loadBtn = $('#loadMore');
const qEl = $('#q');
const sortEl = $('#sort');
const settingsDlg = $('#settings');
const prefPreview = $('#prefPreview');
const prefMuted = $('#prefMuted');
const toggleViewBtn = $('#toggleView');

let items = [];
let page = 0;
let pageSize = window.matchMedia('(max-width: 768px)').matches ? 12 : 21;

function showToggleIfMobile(){
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  toggleViewBtn.hidden = !isMobile;
}
showToggleIfMobile();
window.addEventListener('resize', showToggleIfMobile);

function restorePrefs(){
  const p = getPrefs();
  prefPreview.checked = !!p.preview;
  prefMuted.checked = !!p.muted;
}
restorePrefs();

function applySort(arr, sort){
  const [key,dir] = sort.split('-');
  const mul = dir === 'asc' ? 1 : -1;
  arr.sort((a,b)=>{
    if (key==='name') return a.name.localeCompare(b.name) * mul;
    if (key==='date') return ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)) * mul;
    return 0;
  });
}

async function loadList(reset=false){
  if (reset){ listEl.innerHTML=''; page=0; }
  const res = await fetch('/api/list?limit=10000&offset=0');
  const payload = await res.json();
  const all = Array.isArray(payload) ? payload : (payload.items || []);
  const q = qEl.value.trim().toLowerCase();
  items = all.filter(v => !q || v.name.toLowerCase().includes(q));
  applySort(items, sortEl.value);
  renderPage();
}

function renderPage(){
  const start = page * pageSize;
  const slice = items.slice(start, start + pageSize);
  for (const it of slice){
    const card = videoCard(it, (item)=>{
      const url = new URL('/watch', location.origin);
      url.searchParams.set('id', item.id);
      location.href = url.toString();
    });
    listEl.appendChild(card);
  }
  page++;
  const hasMore = page * pageSize < items.length;
  loadBtn.style.display = hasMore ? 'inline-flex' : 'none';
}

loadBtn.addEventListener('click', ()=> renderPage());
qEl.addEventListener('input', ()=> loadList(true));
sortEl.addEventListener('change', ()=> loadList(true));

document.querySelector('#openSettings').addEventListener('click', ()=> settingsDlg.showModal());
settingsDlg.addEventListener('click', (e)=>{ if (e.target === settingsDlg) settingsDlg.close(); });
window.addEventListener('keydown', (e)=>{ if (e.key==='Escape' && settingsDlg.open) settingsDlg.close(); });

prefPreview.addEventListener('change', ()=> setPref('preview', prefPreview.checked));
prefMuted.addEventListener('change', ()=> setPref('muted', prefMuted.checked));

toggleViewBtn.addEventListener('click', ()=>{
  const isList = listEl.classList.toggle('list');
  toggleViewBtn.title = isList ? 'Grid view' : 'List view';
});

loadList(true);
