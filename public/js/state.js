// public/js/state.js (v7)
let prefs = { preview:false, muted:true };
try {
  const s = localStorage.getItem('prefs');
  if (s) Object.assign(prefs, JSON.parse(s));
} catch {}
export function getPrefs(){ return prefs; }
export function setPref(k, v){
  prefs[k] = v;
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch {}
}
