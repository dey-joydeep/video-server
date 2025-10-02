export const state = {
  isMobile: matchMedia('(max-width: 768px)').matches,
  view: 'grid',
  page: 0,
  pageSize: 21,
  items: [],
  q: '',
  sort: 'name-asc',
  prefs: { preview: false, volume: 0.0 }
};

export function loadPrefs(){
  try {
    const s = localStorage.getItem('prefs');
    if (s){ Object.assign(state.prefs, JSON.parse(s)); }
  } catch {}
}
export function savePrefs(){
  try { localStorage.setItem('prefs', JSON.stringify(state.prefs)); } catch {}
}
