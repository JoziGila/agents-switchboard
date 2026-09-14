import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Content watchdog defaults (SPEC: the DeepSeek keep-alive stall). Configurable per relay, not yet from config. */
export const DEFAULT_FIRST_EVENT_MS = 60_000;
export const DEFAULT_IDLE_MS = 120_000;

/**
 * Line-oriented SSE relay. `mapData` may rewrite each `data:` payload; `onEvent` observes parsed JSON payloads.
 * When `pingMs` is set and nothing flowed for that long, a synthetic `ping` event is written.
 *
 * Content watchdog: a `:`-comment (or our own ping) is not content. If no real `data:`/`event:` line arrives
 * within `firstEventMs` of relay creation, or `idleMs` passes between two of them, the relay stalls: it pushes
 * `stallPayload(stalledAfterMs)` (the caller's dialect-shaped terminal error frame, if given), ends the client
 * stream, calls `abort()` (the caller's hook to tear down the upstream request/response), and reports
 * `{ error: 'upstream stall', stalledAfterMs }` via `onStall` so the route can log it as a failed request
 * instead of a silent hang. Pass `firstEventMs`/`idleMs` as `0` or `null` to disable the watchdog.
 */
export function createSseRelay({
  mapData, onEvent, pingMs, pingPayload = 'event: ping\ndata: {"type":"ping"}\n\n',
  firstEventMs = DEFAULT_FIRST_EVENT_MS, idleMs = DEFAULT_IDLE_MS, stallPayload, onStall, abort,
} = {}) {
  const decoder = new StringDecoder('utf8'); // a multi-byte character may be split across TCP chunks
  const start = Date.now();
  let rest = '';
  let pingTimer = null;
  let watchdogTimer = null;
  let sawContent = false;
  let stalled = false;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      if (stalled) { cb(); return; } // upstream kept sending after we already ended the client stream
      rest += decoder.write(chunk);
      const lines = rest.split('\n');
      rest = lines.pop();
      const out = [];
      for (const line of lines) out.push(handle(line));
      armPing();
      cb(null, out.join(''));
    },
    flush(cb) {
      disarmPing(); disarmWatchdog();
      rest += decoder.end();
      cb(null, stalled ? '' : rest ? handle(rest) : '');
    },
  });
  function handle(line) {
    const isContent = line.startsWith('data:') || line.startsWith('event:'); // not a `:`-comment, not blank
    if (isContent) noteContent();
    if (line.startsWith('data:')) {
      let data = line.slice(5).replace(/^ /, '');
      if (onEvent && data && data !== '[DONE]') { try { onEvent(JSON.parse(data)); } catch {} }
      if (mapData && data && data !== '[DONE]') data = mapData(data);
      return `data: ${data}\n`;
    }
    return line + '\n';
  }
  function noteContent() { sawContent = true; armWatchdog(); }
  function armPing() {
    if (!pingMs) return;
    disarmPing();
    pingTimer = setTimeout(() => { if (!t.destroyed) { t.push(pingPayload); armPing(); } }, pingMs);
  }
  function disarmPing() { if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; } }
  function armWatchdog() {
    disarmWatchdog();
    const ms = sawContent ? idleMs : firstEventMs;
    if (!ms) return; // disabled
    watchdogTimer = setTimeout(stall, ms);
  }
  function disarmWatchdog() { if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; } }
  function stall() {
    if (stalled || t.destroyed) return;
    stalled = true;
    disarmPing(); disarmWatchdog();
    const stalledAfterMs = Date.now() - start;
    // Push the terminal frame and end the readable side before aborting the upstream, so the client's
    // error event is queued ahead of whatever `abort()` triggers on the pipeline (an upstream destroy).
    if (stallPayload) { try { t.push(stallPayload(stalledAfterMs)); } catch {} }
    t.push(null);
    if (onStall) { try { onStall({ error: 'upstream stall', stalledAfterMs }); } catch {} }
    if (typeof abort === 'function') { try { abort(); } catch {} }
  }
  t.on('close', () => { disarmPing(); disarmWatchdog(); });
  armPing();
  armWatchdog();
  return t;
}
