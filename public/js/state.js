export const DEFAULTS = {
  PREVIEW: true,
  VOLUME: 0.6, // 60%
};

export const state = {
  isMobile:
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    ),
  isTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  view: 'grid',
  page: 0,
  pageSize: 21,
  items: [],
  q: '',
  sort: 'name-asc',
  prefs: { preview: DEFAULTS.PREVIEW, volume: DEFAULTS.VOLUME },
};

export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('prefs') || '{}');
    if (p && typeof p === 'object') {
      if (typeof p.preview === 'boolean') state.prefs.preview = p.preview;
      if (typeof p.volume === 'number') state.prefs.volume = p.volume;
    }
  } catch {
    /* Ignored */
  }
}

export function savePrefs() {
  try {
    localStorage.setItem('prefs', JSON.stringify(state.prefs));
  } catch {
    /* Ignored */
  }
}
