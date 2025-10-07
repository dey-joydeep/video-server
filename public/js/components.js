export function cardHtml(it) {
  const t = it.thumb ? `/thumbs/${it.thumb}` : './assets/placeholder.svg';
  const date = new Date(it.mtimeMs).toLocaleString();
  return `<div class="card" data-id="${it.id}" data-name="${it.name}" tabindex="0" role="button" aria-label="Open ${it.name}">
    <img class="thumb" src="${t}" alt="${it.name}">
    <div class="title" title="${it.name}">${it.name}</div>
    <div class="meta">${date}</div>
  </div>`;
}
