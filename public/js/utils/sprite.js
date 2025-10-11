// Simple WebVTT sprite parser.
// Supports cues in the form:
// 00:00:01.000 --> 00:00:04.000
// thumbs/abcd/abcd_sprite.jpg#xywh=160,90,160,90
// Returns an array of { start, end, sheet, x, y, w, h }

export async function fetchAndParseVtt(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load VTT: ${res.status}`);
  const text = await res.text();
  return parseVtt(text, url);
}

export function parseVtt(text) {
  const lines = text.split(/\r?\n/);
  const cues = [];
  let i = 0;
  function toSeconds(ts) {
    // hh:mm:ss.mmm or mm:ss.mmm
    const m = ts
      .trim()
      .match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?/);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const mn = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    const ms = parseInt(m[4] || '0', 10);
    return h * 3600 + mn * 60 + s + (ms ? ms / 1000 : 0);
  }
  while (i < lines.length) {
    const line = lines[i].trim();
    i += 1;
    if (!line) continue;
    if (line.startsWith('WEBVTT')) continue;
    // Skip optional cue id lines
    let timing = line;
    if (!line.includes('-->') && i < lines.length) {
      timing = lines[i].trim();
      i += 1;
    }
    if (!timing.includes('-->')) continue;
    const [startStr, endStr] = timing.split('-->').map((s) => s.trim());
    // Next non-empty line is the payload with sprite ref
    let payload = '';
    while (i < lines.length && !(payload = lines[i].trim())) i += 1;
    i += 1;
    if (!payload) continue;
    // Expect something like: path/to/sprite.jpg#xywh=10,20,160,90
    const xy = payload.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
    const sheet = payload.split('#')[0];
    if (!xy || !sheet) continue;
    cues.push({
      start: toSeconds(startStr),
      end: toSeconds(endStr),
      sheet,
      x: parseInt(xy[1], 10),
      y: parseInt(xy[2], 10),
      w: parseInt(xy[3], 10),
      h: parseInt(xy[4], 10),
    });
  }
  return cues;
}

export function findCue(cues, second) {
  // binary search could be used; linear is fine for small lists
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i];
    if (second >= c.start && second < c.end) return c;
  }
  return null;
}
