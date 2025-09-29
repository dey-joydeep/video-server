import { getPrefs } from './state.js';
import { renderCards } from './components.js';

const v = document.getElementById('v');
const moreEl = document.getElementById('moreList');
const moreBtn = document.getElementById('moreBtn');

const params = new URLSearchParams(location.search);
const id = params.get('id');

(async function init(){
  if(!id){ location.href='/'; return; }
  v.src = `/v/${encodeURIComponent(id)}`;
  v.setAttribute('disablepictureinpicture','');
  v.setAttribute('controlsList','nodownload');
  v.muted = getPrefs().muted;

  window.addEventListener('keydown', (e)=>{
    const step = e.shiftKey ? 10 : 5;
    if(e.key === 'ArrowRight'){ v.currentTime = Math.min((v.currentTime||0)+step, v.duration||1e6); e.preventDefault(); }
    if(e.key === 'ArrowLeft'){ v.currentTime = Math.max((v.currentTime||0)-step, 0); e.preventDefault(); }
    if(e.key === 'ArrowUp'){ v.volume = Math.min(1, (v.volume||0)+0.05); e.preventDefault(); }
    if(e.key === 'ArrowDown'){ v.volume = Math.max(0, (v.volume||0)-0.05); e.preventDefault(); }
    if(e.key === ' '){ if(v.paused) v.play(); else v.pause(); e.preventDefault(); }
  }, {passive:false});

  v.addEventListener('mouseup', ()=> v.blur());
  v.addEventListener('touchend', ()=> v.blur(), {passive:true});
  v.addEventListener('contextmenu', e=> e.preventDefault());

  await loadMore(true);
})();

let all=[], idx=0;
async function loadMore(initial=false){
  if(initial){
    const res = await fetch('/api/list');
    const data = await res.json();
    all = Array.isArray(data) ? data : (data.items||[]);
    all = all.filter(x => x.id !== id);
    idx = 0;
  }
  const take = 14;
  const slice = all.slice(idx, idx+take);
  idx += slice.length;
  renderCards(moreEl, slice);
  installMoreClicks();
  moreBtn.classList.toggle('hide', idx >= all.length);
}

function installMoreClicks(){
  document.querySelectorAll('.card').forEach(card => {
    const vid = card.dataset.id;
    card.addEventListener('click', (e)=>{
      e.preventDefault();
      location.href = `/watch?id=${encodeURIComponent(vid)}`;
    }, {passive:false});
  });
}

moreBtn.addEventListener('click', ()=> loadMore(false));