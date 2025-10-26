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

