function formatDuration(ms) {
  if (!ms || ms < 1000) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const paddedSeconds = seconds.toString().padStart(2, '0');
  const paddedMinutes = minutes.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

function cardHtml(it) {
  const t = it.thumb ? `/thumbs/${it.thumb}` : '/placeholder.svg';
  const duration = formatDuration(it.durationMs);
  return `<div class="card" data-id="${it.id}" data-name="${it.name}" tabindex="0" role="button" aria-label="Open ${it.name}">
    <img class="thumb" src="${t}" alt="${it.name}">
    <div class="title" title="${it.name}">${it.name}</div>
    <div class="meta">${duration}</div>
  </div>`;
}

export function renderCards(container, items) {
  container.innerHTML = items.map(cardHtml).join('');
}

export function initCardEventListeners(container, state) {
  const cardStates = new WeakMap();

  const getCardState = (card) => {
    if (!cardStates.has(card)) {
      cardStates.set(card, {
        previewState: 'idle',
        videoEl: null,
        timer: null,
      });
    }
    return cardStates.get(card);
  };

  const startPreview = (card) => {
    const cardState = getCardState(card);
    cardState.previewState = 'loading';

    const id = card.dataset.id;
    const videoItem = state.items.find((it) => it.id === id);
    const previewClip = videoItem?.previewClip;

    if (!state.prefs.preview || !previewClip) {
      cardState.previewState = 'idle';
      return;
    }

    const img = card.querySelector('.thumb');
    if (!img) {
      cardState.previewState = 'idle';
      return;
    }

    const videoEl = document.createElement('video');
    cardState.videoEl = videoEl;
    videoEl.classList.add('thumb');
    videoEl.src = previewClip;
    videoEl.muted = true;
    videoEl.loop = true;
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoEl.autoplay = true;
    videoEl.disableRemotePlayback = true;
    videoEl.style.opacity = '0';
    videoEl.style.transition = 'opacity 120ms ease';

    img.replaceWith(videoEl);

    const showOnFirstFrame = () => {
      try {
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
          videoEl.requestVideoFrameCallback(() => {
            videoEl.style.opacity = '1';
          });
        } else {
          requestAnimationFrame(() => {
            videoEl.style.opacity = '1';
          });
        }
      } catch {
        /* ignore */
      }
    };

    const onCanPlay = async () => {
      if (cardState.previewState !== 'loading') return;
      if (!videoEl || !videoEl.isConnected) return;

      try {
        await videoEl.play();
        cardState.previewState = 'playing';
        showOnFirstFrame();
      } catch {
        cancelPreview(card); // If play fails, cancel everything
      }
    };

    videoEl.addEventListener('canplay', onCanPlay, { once: true });
  };

  const cancelPreview = (card) => {
    const cardState = getCardState(card);
    clearTimeout(cardState.timer);
    cardState.timer = null;

    if (cardState.videoEl) {
      cardState.videoEl.pause();
      const img = new Image();
      const id = card.dataset.id;
      const videoItem = state.items.find((it) => it.id === id);
      img.src = videoItem.thumb
        ? `/thumbs/${videoItem.thumb}`
        : './assets/placeholder.svg';
      img.classList.add('thumb');
      cardState.videoEl.replaceWith(img);
      cardState.videoEl = null;
    }
    cardState.previewState = 'idle';
  };

  container.addEventListener(
    'mouseenter',
    (e) => {
      if (state.isMobile) return;
      const card = e.target.closest('.card');
      if (!card) return;

      const cardState = getCardState(card);
      if (cardState.previewState === 'idle') {
        cardState.previewState = 'timing';
        cardState.timer = setTimeout(() => startPreview(card), 250);
      }
    },
    true
  );

  container.addEventListener(
    'mouseleave',
    (e) => {
      if (state.isMobile) return;
      const card = e.target.closest('.card');
      if (!card) return;
      cancelPreview(card);
    },
    true
  );

  // Simplified touch handling for now
  container.addEventListener(
    'touchstart',
    (e) => {
      if (!state.isTouch) return;
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      const cardState = getCardState(card);
      if (cardState.previewState === 'idle') {
        cardState.previewState = 'timing';
        cardState.timer = setTimeout(() => startPreview(card), 250);
      }
    },
    { passive: false }
  );

  container.addEventListener('touchend', (e) => {
    if (!state.isTouch) return;
    const card = e.target.closest('.card');
    if (!card) return;
    cancelPreview(card);
  });

  container.addEventListener('touchcancel', (e) => {
    if (!state.isTouch) return;
    const card = e.target.closest('.card');
    if (!card) return;
    cancelPreview(card);
  });

  container.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    const id = card.dataset.id;
    location.href = `./player.html?id=${encodeURIComponent(id)}`;
  });

  container.addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = card.dataset.id;
      location.href = `./player.html?id=${encodeURIComponent(id)}`;
    }
  });
}
