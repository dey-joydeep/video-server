async function load() {
  const res = await fetch('/api/list');
  const data = await res.json();
  const files = data.files || {};
  const grid = document.getElementById('grid');
  const entries = Object.entries(files);
  entries.sort((a,b)=> a[0].localeCompare(b[0]));
  grid.innerHTML = entries.map(([rel, rec]) => {
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    return `
      <a class="card" href="/video/${encodeURIComponent(rel)}" title="${rel}">
        <img class="thumb" loading="lazy" src="/thumbs/${rec.thumb}" alt="">
        <div class="name">${rel.split('/').pop()}</div>
        <div class="path">${folder}</div>
      </a>
    `;
  }).join('');
}
load();
