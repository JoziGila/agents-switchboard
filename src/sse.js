import { Transform } from 'node:stream';

/**
 * Line-oriented SSE relay. `mapData` may rewrite each `data:` payload; `onEvent` observes parsed JSON payloads.
 * When `pingMs` is set and nothing flowed for that long, a synthetic `ping` event is written.
 */
export function createSseRelay({ mapData, onEvent, pingMs, pingPayload = 'event: ping\ndata: {"type":"ping"}\n\n' } = {}) {
  let rest = '';
  let timer = null;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      rest += chunk.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop();
      const out = [];
      for (const line of lines) out.push(handle(line));
      arm();
      cb(null, out.join(''));
    },
    flush(cb) {
      disarm();
      cb(null, rest ? handle(rest) : '');
    },
  });
  function handle(line) {
    if (line.startsWith('data:')) {
      let data = line.slice(5).replace(/^ /, '');
      if (onEvent && data && data !== '[DONE]') { try { onEvent(JSON.parse(data)); } catch {} }
      if (mapData && data && data !== '[DONE]') data = mapData(data);
      return `data: ${data}\n`;
    }
    return line + '\n';
  }
  function arm() {
    if (!pingMs) return;
    disarm();
    timer = setTimeout(() => { if (!t.destroyed) { t.push(pingPayload); arm(); } }, pingMs);
  }
  function disarm() { if (timer) { clearTimeout(timer); timer = null; } }
  t.on('close', disarm);
  arm();
  return t;
}
