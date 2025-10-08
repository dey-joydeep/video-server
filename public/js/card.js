function cardHtml(it) {
  const t = it.thumb ? `/thumbs/${it.thumb}` : './assets/placeholder.svg';
  const date = new Date(it.mtimeMs).toLocaleString();
  return `<div class="card" data-id="${it.id}" data-name="${it.name}" tabindex="0" role="button" aria-label="Open ${it.name}">
    <img class="thumb" src="${t}" alt="${it.name}">
    <div class="title" title="${it.name}">${it.name}</div>
    <div class="meta">${date}</div>
  </div>`;
}

export function renderCards(container, items) {
  container.innerHTML = items.map(cardHtml).join('');
}

export function initCardEventListeners(container, state) {
  const cardStates = new WeakMap();

  const getCardState = (card) => {
    if (!cardStates.has(card)) {
      cardStates.set(card, {});
    }
    return cardStates.get(card);
  };

  const startPreview = (card) => {
    const cardState = getCardState(card);
    if (cardState.inFlight || cardState.isPreviewing) {
      return;
    }
    cardState.inFlight = true;

    const id = card.dataset.id;
    const videoItem = state.items.find((it) => it.id === id);
    const previewClip = videoItem?.previewClip;

    if (!state.prefs.preview || !previewClip) {
      cardState.inFlight = false;
      return;
    }

    const img = card.querySelector('.thumb');
    if (!img) {
      cardState.inFlight = false;
      return;
    }

    const videoEl = document.createElement('video');
    cardState.videoEl = videoEl;
    videoEl.classList.add('thumb');
    videoEl.src = previewClip;
    videoEl.muted = true;
    videoEl.setAttribute('muted', '');
    videoEl.defaultMuted = true;
    videoEl.loop = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
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
      } catch { /* ignore */ }
    };

    const tryStart = async () => {
      if (cardState.isPreviewing) return;
      if (!videoEl || !videoEl.isConnected) return;
      let ahead = 0;
      try {
        const b = videoEl.buffered;
        if (b && b.length) {
          ahead = b.end(b.length - 1) - videoEl.currentTime;
        }
      } catch { /* ignore */ }

      if (ahead >= 1.5 || videoEl.readyState >= 3) {
        try {
          await videoEl.play();
        } catch { /* ignore */ }
        videoEl.loop = true;
        try {
          showOnFirstFrame();
        } catch { /* ignore */ }
        cardState.isPreviewing = true;
        cardState.inFlight = false;
        videoEl.removeEventListener('progress', tryStart);
        videoEl.removeEventListener('loadeddata', tryStart);
      }
    };

    videoEl.addEventListener('loadeddata', tryStart, { once: true });
    videoEl.addEventListener('progress', tryStart);

    cardState.watchdog = setTimeout(() => {
      if (!cardState.isPreviewing) {
        cardState.inFlight = false;
      }
    }, 1000);
  };

  const cancelPreview = (card) => {
    const cardState = getCardState(card);
    clearTimeout(cardState.previewTimer);
    cardState.previewTimer = null;
    clearTimeout(cardState.watchdog);

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
    cardState.isPreviewing = false;
    cardState.inFlight = false;
  };

  container.addEventListener(
    'mouseenter',
    (e) => {
      if (state.isMobile) return;
      const card = e.target.closest('.card');
      if (!card) return;

      const cardState = getCardState(card);
      if (cardState.previewTimer) {
        clearTimeout(cardState.previewTimer);
        cardState.previewTimer = null;
      }
      if (cardState.isPreviewing || cardState.inFlight || cardState.videoEl) {
        return;
      }
      cardState.previewTimer = setTimeout(() => startPreview(card), 250);
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

  container.addEventListener(
    'touchstart',
    (e) => {
      if (!state.isTouch) return;
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      const cardState = getCardState(card);
      cardState.previewTimer = setTimeout(() => startPreview(card), 250);
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