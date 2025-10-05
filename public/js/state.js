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
    prefs: { preview: false, volume: 0.0 },
};

export function loadPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem('prefs') || '{}');
        if (p && typeof p === 'object') Object.assign(state.prefs, p);
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
