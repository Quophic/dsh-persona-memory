// @ts-check
/**
 * Per-request memory injection. The system-prompt variable provider is
 * synchronous, so this reads the small memory files synchronously each
 * request and renders a bounded block (hermes "legacy-inject" style).
 */

/**
 * @param {import('./memory-store.js').ReturnType<typeof import('./memory-store.js').createMemoryStore>} store
 * @param {{ memoryCharLimit: number, userCharLimit: number }} config
 * @returns {string} the `{{memory_profile}}` variable value
 */
export function renderMemoryBlock(store, config) {
  const mem = store.readSync('memory', config.memoryCharLimit);
  const user = store.readSync('user', config.userCharLimit);
  const parts = [];
  if (mem.entryCount > 0) parts.push(`### MEMORY (facts, preferences, conventions)\n${mem.content}`);
  if (user.entryCount > 0) parts.push(`### USER (profile)\n${user.content}`);
  if (parts.length === 0) {
    return '_empty — use the `memory` tool to record durable facts about the user and your work._';
  }
  return parts.join('\n\n');
}
