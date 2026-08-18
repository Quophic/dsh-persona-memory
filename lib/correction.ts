/**
 * Correction pattern detection — ported from pi-hermes-memory's
 * correction-detector.ts (MIT). A two-pass filter on user messages:
 *
 * - Strong patterns: always trigger (high confidence these are corrections)
 * - Weak patterns: only trigger when followed by a directive clause
 * - Negative patterns: suppress even when a positive pattern matched
 *
 * The durable `user/message` session event carries `source.kind === 'user'`
 * for direct human prompts (web client, headless, commands) and `'plugin'`
 * for synthetic contexts, so detection only runs on real human input.
 */

/** Strong patterns — always trigger (high confidence these are corrections) */
export const CORRECTION_STRONG_PATTERNS: RegExp[] = [
  /don'?t do that/i,
  /not like that/i,
  /^I said\b/i,
  /^I told you\b/i,
  /we already discussed/i,
  /^please don'?t/i,
  /^that'?s not what I/i,
];

/** Weak patterns — only trigger if followed by a directive (verb or "the/that/this") */
export const CORRECTION_WEAK_PATTERNS: RegExp[] = [
  /^no[,.\s!]/i,
  /^wrong[,.\s!]/i,
  /^actually[,.\s]/i,
  /^stop[,.\s!]/i,
];

/** Negative patterns — suppress trigger even if a positive pattern matches */
export const CORRECTION_NEGATIVE_PATTERNS: RegExp[] = [
  /^no worries/i,
  /^no problem/i,
  /^no thanks/i,
  /^no need/i,
  /^actually.{0,10}(looks? great|perfect|good|correct|right)/i,
  /^stop.{0,5}(there|here|for now)/i,
];

/** Directive words required after weak correction patterns */
export const CORRECTION_DIRECTIVE_WORDS: string[] = [
  'use', "don't", 'dont', 'do', 'try', 'make', 'run', 'install', 'add',
  'remove', 'delete', 'change', 'fix', 'put', 'set', 'write', 'go', 'stop',
  'start', 'the', 'that', 'this', 'it',
];

/**
 * Extract the directive part from a correction message.
 * E.g. "no, use pnpm instead" -> "use pnpm instead"
 */
export function extractCorrectionDirective(text: string): string {
  const cleaned = text
    .replace(/^(no|wrong|actually|stop|don'?t|that'?s not|I said|I told you)[,.\s!]+/i, '')
    .replace(/^(please\s+)?/i, '')
    .trim();
  return cleaned || text;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join('|');
  return new RegExp(`\\b(${source})\\b`, 'i').test(remainder);
}

function compilePatterns(configured: string[] | undefined, defaults: RegExp[]): RegExp[] {
  if (configured === undefined) return defaults;
  const patterns: RegExp[] = [];
  for (const source of configured) {
    try {
      patterns.push(new RegExp(source, 'i'));
    } catch {
      // ignore invalid configured regex entries; valid entries still apply
    }
  }
  return patterns;
}

export interface CorrectionConfig {
  correctionStrongPatterns?: string[];
  correctionWeakPatterns?: string[];
  correctionNegativePatterns?: string[];
  correctionDirectiveWords?: string[];
}

/** Read one optional string-array config field from a loose config object. */
function readStrArray(config: unknown, key: string): string[] | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const v = (config as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/**
 * Check if a user message is a correction using the two-pass filter.
 * The full plugin config object is accepted as-is (it carries no pattern
 * overrides unless the user configured custom regexes).
 */
export function isCorrection(text: string, config?: unknown): boolean {
  const negative = compilePatterns(readStrArray(config, 'correctionNegativePatterns'), CORRECTION_NEGATIVE_PATTERNS);
  const strong = compilePatterns(readStrArray(config, 'correctionStrongPatterns'), CORRECTION_STRONG_PATTERNS);
  const weak = compilePatterns(readStrArray(config, 'correctionWeakPatterns'), CORRECTION_WEAK_PATTERNS);
  const directiveWords = readStrArray(config, 'correctionDirectiveWords') ?? CORRECTION_DIRECTIVE_WORDS;

  // Negative patterns first — suppress even if positive matches.
  for (const pattern of negative) {
    if (pattern.test(text)) return false;
  }
  // Strong patterns — always trigger.
  for (const pattern of strong) {
    if (pattern.test(text)) return true;
  }
  // Weak patterns — only trigger when followed by a directive clause.
  for (const pattern of weak) {
    if (pattern.test(text)) {
      const match = pattern.exec(text);
      if (match && match.index === 0) {
        const remainder = text.slice(match[0].length).trim();
        if (hasDirectiveWord(remainder, directiveWords)) return true;
      }
    }
  }
  return false;
}
