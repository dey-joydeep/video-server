// public/js/components.js (v7)
import { getPrefs } from './state.js?v=7';

let activePreview = null;
function stopActivePreview(){
  if (activePreview && activePreview.stop) activePreview.stop();
  activePreview = null;
}

function startStoryboard(videoEl, durationSec) {
  const prefs = getPrefs();
  if (!prefs.preview) return null;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = 30;
  }

  let totalPreview = 12;
  const hop = 3;
  if (durationSec < 3) totalPreview = Math.max(1, Math.floor(durationSec));
  else if (durationSec < 12) totalPreview = Math.floor(durationSec - 0.5);

  const steps = Math.max(1, Math.floor(totalPreview / hop));
  const maxStart = Math.max(0, durationSec - hop - 0.5);
  const seed = Math.floor(Math.random()*100000);
  const rand = (i)=>{ const x = Math.sin((i+seed)*999)*10000; return x - Math.floor(x); };
  const times = Array.from({length:steps}, (_,i)=> Math.min(maxStart, rand(i)*maxStart));

  let idx = 0, cancelled = false;
  const tick = () => {
    if (cancelled) return;
    if (idx >= times.length) idx = 0;
    try{ videoEl.currentTime = times[idx]; }catch{}
    idx++;
  };
  const onLoaded = () => tick();
  videoEl.addEventListener('loadedmetadata', onLoaded);
  const interval = setInterval(tick, hop*1000);
  return { stop(){ cancelled=true; clearInterval(interval); videoEl.removeEventListener('loadedmetadata', onLoaded);} };
}

export function fmtDuration(ms){
  if (!ms || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms/1000));
  const mm = Math.floor(s/60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2,'0')}`;
}

export function videoCard(item, onOpen){
  const vthumb = item.thumb ? `/thumbs/${item.thumb}` : `/placeholder.svg`;
  const time = fmtDuration(item.durationMs);

  const card = document.createElement('div');
  card.className = 'card';
  card.title = item.name;
  card.setAttribute('role','button');
  card.tabIndex = 0;

  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = vthumb;

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span>${time || ''}</span>`;

  // ---- Preview handling ----
  let pv = null;
  let controller = null;
  const ensurePreview = () => {
    const prefs = getPrefs();
    if (!prefs.preview) return;
    if (pv) return;
    pv = document.createElement('video');
    pv.muted = true; pv.playsInline = true; pv.autoplay = true; pv.loop = true; pv.preload = 'metadata';
    pv.src = `/v/${encodeURIComponent(item.id)}`;
    pv.className = 'thumb';
    card.replaceChild(pv, img);
    stopActivePreview();
    controller = startStoryboard(pv, (item.durationMs||0)/1000);
    activePreview = controller;
  };
  const stopPreview = () => {
    if (!pv) return;
    pv.pause();
    if (controller) controller.stop();
    card.replaceChild(img, pv);
    pv = null; controller = null; activePreview = null;
  };

  card.addEventListener('mouseenter', ensurePreview, {passive:true});
  card.addEventListener('mouseleave', stopPreview, {passive:true});
  const io = new IntersectionObserver(entries => entries.forEach(e=>{ if (!e.isIntersecting) stopPreview(); }), {threshold:0.01});
  io.observe(card);
  window.addEventListener('scroll', stopPreview, {passive:true});

  // Touch preview and navigation
  let suppressClickUntil = 0;
  card.addEventListener('touchstart', () => {
    ensurePreview();
    suppressClickUntil = Date.now() + 400;
    setTimeout(stopPreview, 2000);
  }, {passive:true});

  // Simple click navigates
  card.addEventListener('click', (e)=>{
    if (Date.now() < suppressClickUntil) return;
    e.preventDefault(); e.stopPropagation();
    onOpen?.(item);
  });

  card.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(item); }
  });

  card.appendChild(img);
  card.appendChild(name);
  card.appendChild(meta);
  return card;
}
