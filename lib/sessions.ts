/**
 * Session provenance — is this a human-driven main session or a derived one?
 *
 * DSH distinguishes the two in the session header: derived sessions (subagent,
 * subagent_fork, workflow children, AgentTeams members) carry
 * `origin: "subagent"`, `parentSession`, and/or `delegationDepth`; a main
 * session started by the user carries none of them (only `cwd`, `agentPreset`,
 * etc.). 0.1.x may carry only the parent link, so every signal is optional and
 * their absence means "human".
 *
 * Memory capture (injection, background learning, correction detection) is
 * gated on this: delegated workers should inherit context from their parent
 * instead of reading/writing the user's persona memory.
 */
export interface SessionProvenance {
  origin?: unknown;
  parentSession?: unknown;
  delegationDepth?: unknown;
}

/** @returns true when the session was spawned as a derived (non-human) run */
export function isDerivedSession(session: unknown): boolean {
  const header = (session as { header?: SessionProvenance } | undefined)?.header;
  if (header === null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return true;
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true;
  return false;
}

/** @returns true when this session should receive the memory prompt blocks */
export function allowsInjection(config: { injectHumanOnly?: boolean }, session: unknown): boolean {
  return !(config.injectHumanOnly === true && isDerivedSession(session));
}

/** Pull the session out of a system-prompt assembly context (agent may be absent). */
export function sessionOf(context: unknown): unknown {
  return (context as { agent?: { session?: unknown } } | undefined)?.agent?.session;
}
