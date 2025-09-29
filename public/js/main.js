import { getPrefs, setPref, isMobile } from './state.js';
import { renderCards } from './components.js';

const qEl = document.getElementById('q');
const sortEl = document.getElementById('sort');
const listEl = document.getElementById('list');
const loadBtn = document.getElementById('loadMore');
const toggleViewBtn = document.getElementById('toggleView');
const settingsBtn = document.getElementById('openSettings');
const modal = document.getElementById('settingsModal');
const prefPreview = document.getElementById('prefPreview');
const prefMuted = document.getElementById('prefMuted');
const modalClose = document.getElementById('closeSettings');

let allItems = [];
let items = [];
let page = 0;
const PAGE_PC = 21;
const PAGE_MOBILE = 12;

function currentPageSize(){ return isMobile() ? PAGE_MOBILE : PAGE_PC; }

function applySort(arr, how){
  const [key,dir] = how.split('-');
  const mul = (dir==='asc') ? 1 : -1;
  arr.sort((a,b)=>{
    if(key==='name') return a.name.localeCompare(b.name) * mul;
    if(key==='date') return (a.mtimeMs - b.mtimeMs) * mul;
    return 0;
  });
}

function installHeaderLogic(){
  const updateVis = () => { toggleViewBtn.classList.toggle('hide', !isMobile()); };
  updateVis(); addEventListener('resize', updateVis);

  const open = () => (modal.classList.add('modal.show'));
  const close = () => (modal.classList.remove('modal.show'));
  settingsBtn.addEventListener('click', open);
  modalClose.addEventListener('click', close);
  modal.addEventListener('click', (e)=>{ if(e.target === modal) close(); });
  addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });

  const p = getPrefs();
  prefPreview.checked = p.preview;
  prefMuted.checked = p.muted;
  prefPreview.addEventListener('change', ()=> setPref('preview', prefPreview.checked));
  prefMuted.addEventListener('change', ()=> setPref('muted', prefMuted.checked));

  qEl.addEventListener('input', ()=> { page=0; filterAndRender(); });
  sortEl.addEventListener('change', ()=> { page=0; filterAndRender(); });
}

function filterAndRender(){
  const q = qEl.value.trim().toLowerCase();
  items = !q ? [...allItems] : allItems.filter(v => v.name.toLowerCase().includes(q));
  applySort(items, sortEl.value);
  renderPage(true);
}

function renderPage(reset=false){
  const LIMIT = currentPageSize();
  const slice = items.slice(0, (page+1)*LIMIT);
  renderCards(listEl, slice);
  installCardInteractions();
  const hasMore = slice.length < items.length;
  loadBtn.classList.toggle('hide', !hasMore);
}

function installCardInteractions(){
  const previewEnabled = getPrefs().preview;
  document.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    const img = card.querySelector('.thumb');

    const open = () => { location.href = `/watch?id=${encodeURIComponent(id)}`; };

    if (!isMobile() && previewEnabled){
      let vid;
      const enter = async () => {
        vid = document.createElement('video');
        vid.muted = true; vid.playsInline = true; vid.autoplay = true; vid.loop = false;
        vid.src = `/v/${encodeURIComponent(id)}`;
        vid.style.width='100%'; vid.style.height='100%'; vid.style.objectFit='cover';
        vid.controls = false; vid.setAttribute('disablepictureinpicture',''); vid.setAttribute('controlsList','nodownload');
        const box = document.createElement('div'); box.style.position='relative'; box.style.width='100%'; box.style.aspectRatio='16/9';
        box.appendChild(vid);
        img.replaceWith(box);

        vid.addEventListener('loadedmetadata', ()=>{
          const dur = Math.max(vid.duration||0, 0);
          let segment = Math.min(3, Math.max(1, dur/4));
          let total = 0;
          const jump = () => {
            if(total >= 12 || vid.paused) return;
            const start = Math.random() * Math.max(0, dur - segment);
            vid.currentTime = start;
            total += segment;
            setTimeout(jump, segment*1000);
          };
          if (dur>0) jump();
        }, {once:true});
      };
      const leave = () => {
        const box = card.querySelector('div[style*="position: relative"]');
        if(box){
          const ph = document.createElement('img');
          ph.className='thumb'; ph.src = img.getAttribute('src'); ph.alt=''; ph.loading='lazy';
          box.replaceWith(ph);
        }
      };
      card.addEventListener('mouseenter', enter);
      card.addEventListener('mouseleave', leave);
      card.addEventListener('blur', leave, true);
      document.addEventListener('visibilitychange', ()=>{ if(document.hidden) leave(); });
    }

    card.addEventListener('click', (e)=>{ e.preventDefault(); open(); }, {passive:false});
    if (isMobile()){
      card.addEventListener('touchend', (e)=>{ e.preventDefault(); open(); }, {passive:false});
    }
  });
}

async function loadList(){
  const res = await fetch('/api/list');
  const all = await res.json();
  allItems = Array.isArray(all) ? all : (all.items || []);
  filterAndRender();
}

document.getElementById('loadMore').addEventListener('click', ()=>{ page++; renderPage(); });
installHeaderLogic();
loadList();