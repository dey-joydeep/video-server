/**
 * @fileoverview Session management services for the video player.
 * This module handles communication with the server's session API endpoints,
 * including starting a new session and waiting for a stream to become ready.
 */

/**
 * Starts a new playback session for a given video ID.
 * @param {string} id The ID of the video.
 * @returns {Promise<object>} A promise that resolves with the session data from the server.
 * @throws {Error} If the request to start the session fails.
 */
export async function startSession(id) {
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = new Error(`Failed to start session: ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Waits for a video stream to be ready using Server-Sent Events (SSE).
 * @param {string} token The session token.
 * @param {object} [options] - Optional parameters.
 * @param {number} [options.timeoutMs=4000] - The timeout in milliseconds.
 * @returns {Promise<object>} A promise that resolves with the ready status data.
 */
export function waitForReadySSE(token, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(
      `/api/session/events?token=${encodeURIComponent(token)}`
    );
    let done = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        es.close();
        reject(new Error('timeout'));
      }, timeoutMs);
    }
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.status === 'ready') {
          if (!done) {
            done = true;
            if (timer) clearTimeout(timer);
            es.close();
            resolve(data);
          }
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        es.close();
        reject(new Error('sse-error'));
      }
    };
  });
}

/**
 * A fallback mechanism that polls the session status endpoint until the stream is ready.
 * @param {string} token The session token.
 * @param {object} [options] - Optional parameters.
 * @param {number} [options.intervalMs=500] - The polling interval in milliseconds.
 * @param {number} [options.maxMs=20000] - The maximum time to poll in milliseconds.
 * @returns {Promise<object>} A promise that resolves with the ready status data.
 */
export function pollUntilReady(
  token,
  { intervalMs = 500, maxMs = 20000 } = {}
) {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/session/status?token=${encodeURIComponent(token)}`,
          { cache: 'no-store' }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && data.status === 'ready' && data.hlsUrl) {
            resolve(data);
            return;
          }
        }
      } catch {
        // ignore and retry
      }
      elapsed += intervalMs;
      if (elapsed >= maxMs) {
        reject(new Error('poll-timeout'));
      } else {
        setTimeout(tick, intervalMs);
      }
    };
    tick();
  });
}
