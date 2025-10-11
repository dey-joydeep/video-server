import { fetchAndParseVtt, findCue } from './utils/sprite.js';

// Attaches sprite preview to a Video.js player's progress control.
// Only activates after the player has enough data (readyState >= 2).
export async function attachSpritePreview(player, vttUrl) {
  if (!player || !vttUrl) return;
  let cues = [];
  try {
    cues = await fetchAndParseVtt(vttUrl);
  } catch (e) {
    console.warn('Sprite VTT load failed', e);
    return;
  }
  if (!cues.length) return;

  const controlBar = player.controlBar;
  if (!controlBar || !controlBar.progressControl) return;
  const progressEl = controlBar.progressControl.el();
  if (!progressEl) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'sprite-preview hidden';
  // inner container makes sizing predictable
  const inner = document.createElement('div');
  inner.className = 'sprite-preview-inner';
  tooltip.appendChild(inner);
  progressEl.appendChild(tooltip);

  let activated = false;
  function ensureActivated() {
    if (activated) return true;
    const rs =
      typeof player.readyState === 'function' ? player.readyState() : 0;
    if (rs >= 2) {
      activated = true;
      return true;
    }
    return false;
  }

  function show() {
    tooltip.classList.remove('hidden');
  }
  function hide() {
    tooltip.classList.add('hidden');
  }

  function updateFromClientX(clientX) {
    const rect = progressEl.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const pct = rect.width > 0 ? x / rect.width : 0;
    const dur = Math.max(player.duration() || 0, 0);
    const t = pct * dur;
    const cue = findCue(cues, t);
    if (!cue) return;
    // Position tooltip horizontally centered above the cursor
    const half = cue.w / 2;
    const left = Math.round(x - half);
    tooltip.style.left = `${left}px`;
    tooltip.style.bottom = `${progressEl.clientHeight + 12}px`;
    inner.style.width = `${cue.w}px`;
    inner.style.height = `${cue.h}px`;
    inner.style.backgroundImage = `url(${cue.sheet})`;
    inner.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
    inner.style.backgroundRepeat = 'no-repeat';
    inner.style.imageRendering = 'auto';
  }

  function onMouseMove(e) {
    if (!ensureActivated()) return;
    updateFromClientX(e.clientX);
  }
  function onMouseEnter(e) {
    if (!ensureActivated()) return;
    show();
    updateFromClientX(e.clientX);
  }
  function onMouseLeave() {
    hide();
  }
  function onTouch(e) {
    if (!ensureActivated()) return;
    if (e.touches && e.touches.length) {
      const t = e.touches[0];
      show();
      updateFromClientX(t.clientX);
    }
  }
  function onTouchEnd() {
    hide();
  }

  progressEl.addEventListener('mousemove', onMouseMove);
  progressEl.addEventListener('mouseenter', onMouseEnter);
  progressEl.addEventListener('mouseleave', onMouseLeave);
  progressEl.addEventListener('touchstart', onTouch, { passive: true });
  progressEl.addEventListener('touchmove', onTouch, { passive: true });
  progressEl.addEventListener('touchend', onTouchEnd, { passive: true });

  // Hide if player disposes
  player.on('dispose', () => {
    progressEl.removeEventListener('mousemove', onMouseMove);
    progressEl.removeEventListener('mouseenter', onMouseEnter);
    progressEl.removeEventListener('mouseleave', onMouseLeave);
    progressEl.removeEventListener('touchstart', onTouch);
    progressEl.removeEventListener('touchmove', onTouch);
    progressEl.removeEventListener('touchend', onTouchEnd);
    if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
  });
}
