const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderStatusPage(s) {
  const rows = (o, cols) => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td>${cols.map((c) => `<td>${esc(v[c] ?? '')}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7">none yet</td></tr>';
  // In-flight has no natural key (several requests can share client/model/role/upstream), so it renders
  // from the array directly instead of going through `rows`.
  const inflight = s.inflight ?? [];
  const inflightRows = inflight.map((f) => `<tr><td>${esc(f.client)}</td><td>${esc(f.model ?? '')}</td><td>${esc(f.role ?? '')}</td><td>${esc(f.upstream ?? '')}</td><td>${esc(Math.round((f.ageMs ?? 0) / 1000))} s</td></tr>`).join('') || '<tr><td colspan="5">none right now</td></tr>';
  return `<!doctype html><meta charset="utf-8"><title>agents-switchboard</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ccc;padding:.3rem .6rem;text-align:left}code{background:#eee;padding:0 .2rem}</style>
<h1>agents-switchboard</h1>
<p>listening on <code>${esc(s.listen)}</code> · up ${esc(s.uptimeSec)} s · DeepSeek ${s.peakNow ? 'peak' : 'off-peak'} pricing now · DeepSeek models: ${s.deepseekModels.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>
<p>failover: ${s.failover.enabled ? `enabled → <code>${esc(s.failover.model)}</code>` : 'disabled'}${Object.entries(s.failover.active ?? {}).map(([c, a]) => ` · <b>${esc(c)} failing over until ${esc(a.until)}</b>`).join('')}</p>
<h2>In flight (${inflight.length})</h2><table><tr><th>client</th><th>model</th><th>role</th><th>upstream</th><th>age</th></tr>${inflightRows}</table>
<p>stalled requests (lifetime): ${esc(s.stalled ?? 0)}</p>
<h2>Models</h2><table><tr><th>model</th><th>requests</th><th>input</th><th>cached</th><th>output</th><th>hit ratio</th><th>est. USD</th></tr>${rows(s.models, ['requests', 'input', 'cached', 'output', 'cacheHitRatio', 'usd'])}</table>
<h2>Roles</h2><table><tr><th>role</th><th>requests</th><th>input</th><th>cached</th><th>hit ratio</th></tr>${rows(s.roles, ['requests', 'input', 'cached', 'cacheHitRatio'])}</table>
<h2>Upstreams</h2><table><tr><th>upstream</th><th>last ok</th><th>last error</th></tr>${rows(s.upstreams, ['lastOk', 'lastError'])}</table>`;
}
