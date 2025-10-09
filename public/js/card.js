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
  let activePreviewCard = null;
  let touchStartPos = null;
  let touchStartTime = 0;

  const getCardState = (card) => {
    if (!cardStates.has(card)) {
      cardStates.set(card, {
        previewState: 'idle',
        videoEl: null,
        timer: null, // Kept for mouseenter
      });
    }
    return cardStates.get(card);
  };

  const startPreview = (card) => {
    if (activePreviewCard && activePreviewCard !== card) {
      cancelPreview(activePreviewCard);
    }
    activePreviewCard = card;

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
        cancelPreview(card);
      }
    };

    videoEl.addEventListener('canplay', onCanPlay, { once: true });
  };

  const cancelPreview = (card) => {
    if (!card) return;
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
        : '/placeholder.svg';
      img.classList.add('thumb');
      cardState.videoEl.replaceWith(img);
      cardState.videoEl = null;
    }
    cardState.previewState = 'idle';
    if (activePreviewCard === card) {
      activePreviewCard = null;
    }
  };

  // --- Mouse Events for Desktop ---
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

  // --- Touch Events for Mobile ---
  container.addEventListener(
    'touchstart',
    (e) => {
      if (!state.isTouch) return;
      touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchStartTime = Date.now();
    },
    { passive: true }
  );

  container.addEventListener('touchend', (e) => {
    if (!state.isTouch || !touchStartPos) return;

    const card = e.target.closest('.card');
    if (!card) return;

    const touchEndPos = {
      x: e.changedTouches[0].clientX,
      y: e.changedTouches[0].clientY,
    };
    const dy = Math.abs(touchEndPos.y - touchStartPos.y);
    const cardHeight = card.offsetHeight;
    const touchDuration = Date.now() - touchStartTime;

    // Reset state for the next touch
    touchStartPos = null;
    touchStartTime = 0;

    // It's a scroll if finger moves more than the card's height
    if (dy > cardHeight) {
      return;
    }

    // It was a press. Check duration to see if it's a tap or long press.
    // Note: e.preventDefault() was removed from the handlers below to fix a
    // console error on mobile where the touchend event was not cancelable.
    // If this re-introduces a "ghost click" (unwanted navigation after a
    // long press), a more complex flag-based solution in the main 'click'
    // handler will be needed.
    if (touchDuration < 250) {
      console.log('Interpreted as tap. Touch duration: ', touchDuration, 'ms');
      // TAP
      if (activePreviewCard) {
        cancelPreview(activePreviewCard);
      }
      const id = card.dataset.id;
      location.href = `./player.html?id=${encodeURIComponent(id)}`;
    } else {
      console.log(
        'Interpreted as long press. Touch duration: ',
        touchDuration,
        'ms'
      );
      // LONG PRESS
      if (getCardState(card).previewState === 'playing') {
        console.log('Cancelling preview.');
        cancelPreview(card);
      } else {
        console.log('Starting preview.');
        startPreview(card);
      }
    }
  });

  // Clicks are for desktop; touch is handled by touchend.
  container.addEventListener('click', (e) => {
    if (state.isTouch) {
      e.preventDefault();
      return;
    }
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
