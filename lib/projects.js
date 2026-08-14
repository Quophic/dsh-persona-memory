// @ts-check
/**
 * Project memory — ported in spirit from pi-hermes-memory's project.ts.
 *
 * A "project" is any working directory that is not the user's home. Inside a
 * Git repository the project name is the REPOSITORY ROOT's basename, so every
 * linked worktree shares one identity; outside Git it stays the cwd basename.
 * An existing `projects-memory/<cwd-basename>/` store still wins over a newly
 * derived repository name (migration bridge).
 *
 * The projects root is Pi-compatible: when the memory dir IS the Pi hermes
 * data dir (`~/.pi/agent/pi-hermes-memory`), the projects root resolves to
 * `~/.pi/agent/projects-memory` so DSH and Pi share the same per-project
 * stores. Otherwise it is `<memoryDir>/projects-memory`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {Map<string, string | null>} */
const repoRootCache = new Map();

/**
 * Resolve the repository root shared by every linked worktree of `dir`'s repo
 * (mirrors `git rev-parse --git-common-dir` without spawning git). Null
 * outside a repository.
 * @param {string} dir
 * @returns {string | null}
 */
export function findGitRepoRoot(dir) {
  let current = path.resolve(dir);
  while (true) {
    const dotGit = path.join(current, '.git');
    let stat;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit);
      if (!commonDir) return current;
      return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * @param {string} worktreeRoot
 * @param {string} dotGitFile
 * @returns {string | null}
 */
function resolveWorktreeCommonDir(worktreeRoot, dotGitFile) {
  let pointer;
  try {
    pointer = fs.readFileSync(dotGitFile, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  const gitDir = path.resolve(worktreeRoot, match[1].trim());
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // not a linked worktree / older layout
  }
  const parent = path.dirname(gitDir);
  return path.basename(parent) === 'worktrees' ? path.dirname(parent) : null;
}

/**
 * Pi-compatible projects root.
 * @param {string} memoryDir
 * @returns {string}
 */
export function resolveProjectsRoot(memoryDir) {
  const home = os.homedir();
  const piHermesDir = path.join(home, '.pi', 'agent', 'pi-hermes-memory');
  if (path.resolve(memoryDir) === path.resolve(piHermesDir)) {
    return path.join(home, '.pi', 'agent', 'projects-memory');
  }
  return path.join(memoryDir, 'projects-memory');
}

/**
 * Detect the project for a working directory.
 * @param {string} cwd
 * @param {string} projectsRoot
 * @returns {{ name: string | null, memoryDir: string | null }}
 */
export function detectProject(cwd, projectsRoot) {
  const resolved = path.resolve(cwd);
  const resolvedHome = path.resolve(os.homedir());
  if (resolved === resolvedHome || resolved === path.parse(resolved).root) {
    return { name: null, memoryDir: null };
  }
  const cwdName = path.basename(resolved);
  if (!cwdName || cwdName === '.' || cwdName === '..') {
    return { name: null, memoryDir: null };
  }
  const name = resolveProjectName(resolved, resolvedHome, cwdName, projectsRoot);
  return { name, memoryDir: path.join(projectsRoot, name) };
}

/**
 * @param {string} resolved
 * @param {string} resolvedHome
 * @param {string} cwdName
 * @param {string} projectsRoot
 * @returns {string}
 */
function resolveProjectName(resolved, resolvedHome, cwdName, projectsRoot) {
  let repoRoot = repoRootCache.get(resolved);
  if (repoRoot === undefined) {
    repoRoot = findGitRepoRoot(resolved);
    repoRootCache.set(resolved, repoRoot);
  }
  if (!repoRoot || repoRoot === resolved || repoRoot === resolvedHome) return cwdName;
  const repoName = path.basename(repoRoot);
  if (!repoName || repoName === cwdName) return cwdName;
  // Migration bridge: keep an identity that already has a store.
  if (!fs.existsSync(path.join(projectsRoot, repoName)) && fs.existsSync(path.join(projectsRoot, cwdName))) {
    return cwdName;
  }
  return repoName;
}

/**
 * Validate a model-supplied project name for the tools (path traversal guard).
 * @param {unknown} name
 * @returns {string | null} sanitized name, or null when unsafe
 */
export function safeProjectName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/[\\/]|\.\./.test(trimmed)) return null;
  return trimmed;
}
