import { state, savePrefs, DEFAULTS } from '../../js/state.js';

// Debounce function to limit how often a function is called
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export async function initSettingsModal() {
  const response = await fetch(
    '/components/settings-modal/settings-modal.html'
  );
  const html = await response.text();
  document.body.insertAdjacentHTML('beforeend', html);

  // --- Element References ---
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('closeSettings');
  const resetBtn = document.getElementById('resetSettings');
  const prefPreview = document.getElementById('prefPreview');
  const prefVolume = document.getElementById('prefVolume');
  const volumeValue = document.getElementById('volumeValue');
  const toastEl = document.getElementById('toast');

  // --- State and Defaults ---

  const focusableElements = Array.from(
    settingsModal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  );
  const firstFocusableEl = focusableElements[0];
  const lastFocusableEl = focusableElements[focusableElements.length - 1];

  // --- Toast Notification ---
  let toastTimer = null;
  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2000);
  }

  // --- Debounced Save ---
  const debouncedSave = debounce(() => {
    savePrefs();
    showToast('Settings saved.');
  }, 500);

  // --- UI Update Functions ---
  function updateVolumeUI(volume) {
    prefVolume.value = volume * 100;
    volumeValue.textContent = `${Math.round(volume * 100)}%`;
    prefVolume.setAttribute('aria-valuenow', Math.round(volume * 100));
  }

  function updateUIFromState() {
    prefPreview.checked = state.prefs.preview;
    updateVolumeUI(state.prefs.volume);
  }

  // --- Modal Logic ---
  function openSettingsModal() {
    updateUIFromState();
    settingsModal.classList.add('show');
    settingsModal.setAttribute('aria-hidden', 'false');
    firstFocusableEl.focus();
    document.addEventListener('keydown', handleKeydown);
  }

  function closeSettingsModal() {
    settingsModal.classList.remove('show');
    settingsModal.setAttribute('aria-hidden', 'true');
    settingsBtn.focus(); // Return focus to the button that opened the modal
    document.removeEventListener('keydown', handleKeydown);
  }

  // --- Event Handlers ---
  function handleKeydown(e) {
    if (e.key === 'Escape') {
      closeSettingsModal();
    }
    if (e.key === 'Tab') {
      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstFocusableEl) {
          lastFocusableEl.focus();
          e.preventDefault();
        }
      } else {
        // Tab
        if (document.activeElement === lastFocusableEl) {
          firstFocusableEl.focus();
          e.preventDefault();
        }
      }
    }
  }

  function handleReset() {
    state.prefs.preview = DEFAULTS.PREVIEW;
    state.prefs.volume = DEFAULTS.VOLUME;
    updateUIFromState();
    debouncedSave();
  }

  // --- Initial Setup ---
  settingsBtn.addEventListener('click', openSettingsModal);
  closeBtn.addEventListener('click', closeSettingsModal);
  resetBtn.addEventListener('click', handleReset);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettingsModal();
    }
  });

  prefPreview.addEventListener('change', () => {
    state.prefs.preview = prefPreview.checked;
    debouncedSave();
  });

  prefVolume.addEventListener('input', () => {
    const volume = parseFloat(prefVolume.value) / 100;
    state.prefs.volume = volume;
    updateVolumeUI(volume);
    debouncedSave();
  });

  // Initialize UI
  updateUIFromState();
}
