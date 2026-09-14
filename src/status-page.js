const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderStatusPage(s) {
  const rows = (o, cols) => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td>${cols.map((c) => `<td>${esc(v[c] ?? '')}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="9">none yet</td></tr>';
  return `<!doctype html><meta charset="utf-8"><title>agents-switchboard</title>
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ccc;padding:.3rem .6rem;text-align:left}code{background:#eee;padding:0 .2rem}</style>
<h1>agents-switchboard</h1>
<p>listening on <code>${esc(s.listen)}</code> · up ${esc(s.uptimeSec)} s · DeepSeek ${s.peakNow ? 'peak' : 'off-peak'} pricing now · DeepSeek models: ${s.deepseekModels.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>
<p>failover: ${s.failover.enabled ? `enabled → <code>${esc(s.failover.model)}</code>` : 'disabled'}${s.failover.active ? ` · <b>active until ${esc(s.failover.active)}</b>` : ''}</p>
<h2>Models</h2><table><tr><th>model</th><th>requests</th><th>input</th><th>cached</th><th>output</th><th>hit ratio</th><th>est. USD</th></tr>${rows(s.models, ['requests', 'input', 'cached', 'output', 'cacheHitRatio', 'usd'])}</table>
<h2>Roles</h2><table><tr><th>role</th><th>requests</th><th>input</th><th>cached</th><th>hit ratio</th></tr>${rows(s.roles, ['requests', 'input', 'cached', 'cacheHitRatio'])}</table>
<h2>Upstreams</h2><table><tr><th>upstream</th><th>last ok</th><th>last error</th></tr>${rows(s.upstreams, ['lastOk', 'lastError'])}</table>`;
}
