// @ts-check
/**
 * dsh-persona-memory — persistent long-term persona memory for DeepSeek Harness.
 *
 * - Storage: MEMORY.md + USER.md, ON-DISK FORMAT SHARED WITH pi-hermes-memory
 *   (entries joined by "\n§\n", metadata in trailing HTML comments), so DSH
 *   and Pi can read and write the same memory files.
 * - Tools: `memory` (read/add/update/delete/rewrite) and `memory_search`,
 *   registered through the harness tool registry.
 * - Injection: per-request system-prompt section (order 55) rendering the
 *   current memory block bounded by memoryCharLimit/userCharLimit.
 * - Safety: every write passes the hermes content scanner (prompt-injection
 *   /exfiltration payloads, credentials, invisible unicode are rejected).
 *
 * Default store directory resolution:
 *   1. explicit `dir` config
 *   2. the Pi hermes data dir when it already has MEMORY.md (share memory)
 *   3. <dshHome>/memory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { registerLifecycleHooks } from './lib/learning.js';
import { renderRecentFailures } from './lib/failures.js';
import { createMemoryStore } from './lib/memory-store.js';
import { registerMemorySearchTool } from './lib/memory-search-tool.js';
import { registerMemoryTool } from './lib/memory-tool.js';
import { renderMemoryBlock } from './lib/prompt.js';
import { createFtsIndex } from './lib/fts.js';
import { detectProject, resolveProjectsRoot } from './lib/projects.js';
import { registerStandingCommand } from './lib/standing-command.js';
import { createStandingStore } from './lib/standing.js';

const name = 'dsh-persona-memory';

/** Services required by this plugin (harness host plane). */
const inject = ['tools', 'systemPrompt', 'commands'];

const PI_HERMES_DIR = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');

/** @param {{ dir?: string } | undefined} cfg */
function resolveDir(cfg) {
  if (cfg?.dir) return cfg.dir;
  // Share memory with Pi's pi-hermes-memory when that store already exists.
  if (fs.existsSync(path.join(PI_HERMES_DIR, 'MEMORY.md'))) return PI_HERMES_DIR;
  return dshHomePath('memory');
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {Record<string, unknown> | undefined} config */
function apply(ctx, config) {
  const cfg = {
    dir: resolveDir(config),
    memoryCharLimit: 5000,
    userCharLimit: 5000, // aligned with pi-hermes-memory DEFAULT_USER_CHAR_LIMIT
    enableSecretScanning: true,
    inject: true,
    sectionOrder: 55,
    searchMaxResults: 10,
    // usage reporting + consolidation nudge
    usageNudgeThreshold: 0.9,
    // correction detection on feedback/record + in-chat pattern detection
    correctionDetection: true,
    correctionPatternDetection: true,
    correctionRateLimitTurns: 3,
    // background learning every N turns via the session's own LLM route
    learnEnabled: true,
    learnIntervalTurns: 10,
    learnRecentTurns: 2,
    learnMaxChars: 6000,
    learnTimeoutMs: 120000,
    // auto-consolidation when a store exceeds its char limit (LLM merge,
    // committed only when strictly smaller and scanner-clean)
    autoConsolidate: true,
    consolidateStaleDays: 30,
    consolidateTimeoutMs: 120000,
    // standing instructions (STANDING.md, always injected, user-authored only)
    standingEnabled: true,
    standingCharLimit: 2000,
    standingMaxEntries: 20,
    // failure memory (failures.md): recent failures injected every request
    failureInjectionEnabled: true,
    failureMaxAgeDays: 7,
    failureMaxEntries: 5,
    failureCharLimit: 10000, // hermes: failures get memoryCharLimit * 2
    // project memory (projects-memory/<name>/MEMORY.md, Pi-compatible root)
    projectEnabled: true,
    projectCharLimit: 5000,
    // FTS5 memory mirror (Extended Store): full-text ranking for memory_search
    memoryFtsEnabled: true,
    ...(config ?? {}),
  };
  cfg.dir = resolveDir(config); // explicit config.dir wins; defaults re-resolved

  const projectsRoot = resolveProjectsRoot(cfg.dir);
  /** @type {Map<string, ReturnType<typeof createMemoryStore>>} */
  const projectStores = new Map();
  /** @param {string} name @returns {ReturnType<typeof createMemoryStore>} */
  const getProjectStore = (name) => {
    let ps = projectStores.get(name);
    if (!ps) {
      ps = createMemoryStore({ dir: path.join(projectsRoot, name), limits: { memory: cfg.projectCharLimit ?? 5000 } });
      projectStores.set(name, ps);
    }
    return ps;
  };

  const store = createMemoryStore({
    dir: cfg.dir,
    limits: {
      memory: cfg.memoryCharLimit,
      user: cfg.userCharLimit,
      failure: cfg.failureCharLimit ?? cfg.memoryCharLimit * 2,
    },
  });
  const standing = createStandingStore({
    dir: cfg.dir,
    maxEntries: cfg.standingMaxEntries,
    maxChars: cfg.standingCharLimit,
  });
  const fts = createFtsIndex({ dir: cfg.dir, enabled: cfg.memoryFtsEnabled });

  registerMemoryTool(ctx, store, cfg, getProjectStore);
  registerMemorySearchTool(ctx, store, cfg, getProjectStore, fts);
  registerLifecycleHooks(ctx, store, cfg);

  if (cfg.standingEnabled) {
    registerStandingCommand(ctx, standing);
  }

  if (cfg.inject) {
    if (cfg.standingEnabled) {
      ctx.systemPrompt.variable('standing_block', () => standing.readSyncBlock());
      ctx.systemPrompt.section({
        name: 'memory:standing',
        order: Math.max(0, cfg.sectionOrder - 5),
        text: '{{standing_block}}',
      });
    }
    if (cfg.failureInjectionEnabled) {
      ctx.systemPrompt.variable('failures_block', () => renderRecentFailures(store, cfg));
      ctx.systemPrompt.section({
        name: 'memory:failures',
        order: Math.max(0, cfg.sectionOrder - 3),
        text: '{{failures_block}}',
      });
    }
    if (cfg.projectEnabled) {
      ctx.systemPrompt.variable('project_block', (context) => {
        const cwd = context?.agent?.session?.header?.cwd;
        if (!cwd) return '';
        const project = detectProject(cwd, projectsRoot);
        if (!project.name) return '';
        const ps = getProjectStore(project.name);
        const read = ps.readSync('memory', cfg.projectCharLimit ?? 5000);
        if (!read.exists || read.entryCount === 0) return '';
        return `### Project memory (${project.name})\n${read.content}`;
      });
      ctx.systemPrompt.section({
        name: 'memory:project',
        order: Math.max(0, cfg.sectionOrder - 2),
        text: '{{project_block}}',
      });
    }
    ctx.systemPrompt.variable('memory_profile', () => renderMemoryBlock(store, cfg));
    ctx.systemPrompt.section({
      name: 'memory:profile',
      order: cfg.sectionOrder,
      text: [
        '## Persistent persona memory',
        'You have a persistent long-term memory stored on disk that survives across sessions, shared with your other agent instances. It is managed through the `memory` tool and searched with `memory_search`.',
        'Keep it current: record durable facts about the user, their preferences, project conventions, and environment details; update or delete entries when they change. User corrections and periodic reviews are captured automatically, but you should still save important facts immediately via `memory add`. Never store credentials — writes are scanned and rejected.',
        'Current memory:',
        '{{memory_profile}}',
      ].join('\n\n'),
    });
  }
}

export { apply, inject, name };
export default { apply, inject, name };
