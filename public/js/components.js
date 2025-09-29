export function cardHTML(it, muted=true){
  const dur = it.durationMs ? fmtTime(it.durationMs/1000) : '';
  const title = it.name;
  return `<article class="card" data-id="${it.id}" data-name="${escapeHtml(it.name)}">
    <img class="thumb" src="/thumbs/${encodeURIComponent(it.thumb||'')}" alt="" loading="lazy">
    <div class="name" title="${escapeHtml(title)}">${escapeHtml(it.name)}</div>
    <div class="badge">${dur}</div>
  </article>`;
}
export function renderCards(container, items){
  container.innerHTML = items.map(it => cardHTML(it)).join('');
}
export function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec/60);
  const s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
export function escapeHtml(s=''){
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}