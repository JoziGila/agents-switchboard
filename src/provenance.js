// Remembers which reasoning items each provider produced, so reasoning is replayed only to the provider
// that can read it. Bounded LRU per provider, persisted to a small JSON file so a router restart does not
// turn a live conversation's own reasoning into "foreign" items.
import fs from 'node:fs';
import path from 'node:path';

/** How long a change waits before it is written out; the write is off the request path either way. */
const FLUSH_MS = 2000;

export function createProvenance({ limit = 20_000, file = null } = {}) {
  /** @type {Map<string, Set<string>>} provider -> ids (insertion order = age) */
  const byProvider = new Map();
  let dirty = false, timer = null;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [provider, ids] of Object.entries(saved)) byProvider.set(provider, new Set(ids.slice(-limit)));
    } catch { /* first run, or unreadable: start empty */ }
  }
  function scheduleFlush() {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...byProvider].map(([p, ids]) => [p, [...ids]]))), { mode: 0o600 });
      } catch { /* best effort: memory stays authoritative */ }
    }, FLUSH_MS);
    timer.unref?.();
  }
  function remember(provider, id) {
    if (!id) return;
    let ids = byProvider.get(provider);
    if (!ids) { ids = new Set(); byProvider.set(provider, ids); }
    ids.add(id);
    if (ids.size > limit) ids.delete(ids.values().next().value);
    dirty = true; scheduleFlush();
  }
  /** A hit refreshes the id's age, so ids a live conversation keeps replaying are never evicted under it. */
  function has(provider, id) {
    const ids = id ? byProvider.get(provider) : undefined;
    if (!ids?.has(id)) return false;
    ids.delete(id); ids.add(id);
    return true;
  }
  return { remember, has };
}
