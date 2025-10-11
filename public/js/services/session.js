// Minimal session helper with SSE fallback

export async function startSession(id) {
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to start session');
  return res.json();
}

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
