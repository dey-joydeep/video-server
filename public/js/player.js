// public/js/player.js (v7)
import { getPrefs } from './state.js?v=7';
import { videoCard } from './components.js?v=7';

const $ = (s)=>document.querySelector(s);
const video = $('#v');
const back = $('#back');
const more = $('#more');
const moreBtn = $('#moreBtn');

function getId(){ const u=new URL(location.href); return u.searchParams.get('id') || u.searchParams.get('f'); }

back.addEventListener('click', ()=>{
  if (history.length > 1) history.back();
  else location.href = '/';
});

(async function init(){
  const id = getId();
  if (!id){ location.href = '/'; return; }
  const prefs = getPrefs();
  video.muted = !!prefs.muted;
  video.src = `/v/${encodeURIComponent(id)}`;
  video.addEventListener('keydown', (e)=>{
    if(e.key==='ArrowUp'){ e.preventDefault(); video.volume = Math.min(1,(video.volume||0)+0.05); }
    if(e.key==='ArrowDown'){ e.preventDefault(); video.volume = Math.max(0,(video.volume||0)-0.05); }
  });

  // Load related (14 per page), excluding current id
  const res = await fetch('/api/list?limit=10000&offset=0');
  const payload = await res.json();
  const all = Array.isArray(payload) ? payload : (payload.items || []);
  const others = all.filter(x=>x.id!==id);
  let page=0, size=14;
  function render(){
    const slice = others.slice(page*size, page*size+size);
    for(const it of slice){
      const card = videoCard(it, (item)=>{
        const url = new URL('/watch', location.origin);
        url.searchParams.set('id', item.id);
        location.href = url.toString();
      });
      more.appendChild(card);
    }
    page++;
    moreBtn.style.display = (page*size < others.length) ? 'inline-flex' : 'none';
  }
  moreBtn.addEventListener('click', render);
  render();
})();
