// Remembers which reasoning items a provider produced, so their encrypted content is sent back only
// to the provider that can read it. Bounded, in-memory, per process.

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
  function has(provider, id) {
    return !!id && (byProvider.get(provider)?.has(id) ?? false);
  }
  return { remember, has };
}
