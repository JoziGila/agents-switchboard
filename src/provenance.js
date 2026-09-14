// Remembers which reasoning items a provider produced, so their encrypted content is sent back only
// to the provider that can read it. Bounded LRU, in-memory: a router restart forgets it, which costs one
// prefix rebuild on the next request of each OpenRouter conversation and nothing else.

export function createProvenance(limit = 20_000) {
  /** @type {Map<string, Set<string>>} provider -> ids (insertion order = age) */
  const byProvider = new Map();
  function remember(provider, id) {
    if (!id) return;
    let ids = byProvider.get(provider);
    if (!ids) { ids = new Set(); byProvider.set(provider, ids); }
    ids.add(id);
    if (ids.size > limit) ids.delete(ids.values().next().value);
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
