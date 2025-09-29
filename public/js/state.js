export const prefsKey = 'vb:prefs:v2';
const defaults = { preview: true, muted: true, view: 'grid' };
export function getPrefs(){
  try{
    const raw = localStorage.getItem(prefsKey);
    if(!raw) return { ...defaults };
    const obj = JSON.parse(raw);
    return { ...defaults, ...obj };
  }catch{ return { ...defaults }; }
}
export function setPref(k, v){
  const p = getPrefs(); p[k] = v;
  localStorage.setItem(prefsKey, JSON.stringify(p));
  return p;
}
export const isMobile = () => matchMedia('(max-width: 768px)').matches || matchMedia('(pointer:coarse)').matches;