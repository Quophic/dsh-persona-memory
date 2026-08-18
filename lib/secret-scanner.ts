/**
 * Content scanner — ported from pi-hermes-memory's content-scanner.ts
 * (MIT, https://github.com/chandra447/pi-hermes-memory), which itself ports
 * hermes-agent/tools/memory_tool.py. DSH and Pi share the same memory files,
 * so both sides must enforce the same write gate: no prompt-injection or
 * exfiltration payloads, no credentials, no invisible unicode.
 */

interface PatternRule {
  pattern: RegExp;
  id: string;
}

interface SecretRule extends PatternRule {
  severity: 'high' | 'medium';
}

const MEMORY_THREAT_PATTERNS: PatternRule[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: 'bypass_restrictions' },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_curl' },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_wget' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: 'read_secrets' },
  { pattern: /authorized_keys/i, id: 'ssh_backdoor' },
  { pattern: /\$HOME\/\.ssh|~\/\.ssh/i, id: 'ssh_access' },
];

const SECRET_PATTERNS: SecretRule[] = [
  // API keys
  { pattern: /\bsk-ant-api\S{10,}\b/, id: 'anthropic_api_key', severity: 'high' },
  { pattern: /\bsk-or-v1-\S{10,}\b/, id: 'openrouter_api_key', severity: 'high' },
  { pattern: /\bsk-\S{20,}\b/, id: 'openai_api_key', severity: 'high' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, id: 'aws_access_key', severity: 'high' },
  // Tokens
  { pattern: /\bghp_\S{10,}\b/, id: 'github_personal_token', severity: 'high' },
  { pattern: /\bghu_\S{10,}\b/, id: 'github_user_token', severity: 'high' },
  { pattern: /\bxoxb-\S{10,}\b/, id: 'slack_bot_token', severity: 'high' },
  { pattern: /\bxapp-\S{10,}\b/, id: 'slack_app_token', severity: 'high' },
  { pattern: /\bntn_\S{10,}\b/, id: 'notion_token', severity: 'high' },
  { pattern: /\bBearer\s+\S{20,}\b/, id: 'bearer_auth_token', severity: 'high' },
  // SSH keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, id: 'private_key_block', severity: 'high' },
  // Environment variable names that indicate secrets
  { pattern: /\bANTHROPIC_API_KEY\b/, id: 'env_anthropic_key', severity: 'medium' },
  { pattern: /\bOPENAI_API_KEY\b/, id: 'env_openai_key', severity: 'medium' },
  { pattern: /\bOPENROUTER_API_KEY\b/, id: 'env_openrouter_key', severity: 'medium' },
  { pattern: /\bGITHUB_TOKEN\b/, id: 'env_github_token', severity: 'medium' },
  { pattern: /\bAWS_SECRET_ACCESS_KEY\b/, id: 'env_aws_secret', severity: 'medium' },
  { pattern: /\bDATABASE_URL\b/, id: 'env_database_url', severity: 'medium' },
  // Inline secret assignments (likely accidental paste)
  { pattern: /\bpassword\s*[=:]\s*\S{6,}\b/i, id: 'password_assignment', severity: 'medium' },
  { pattern: /\bsecret\s*[=:]\s*\S{6,}\b/i, id: 'secret_assignment', severity: 'medium' },
  { pattern: /\btoken\s*[=:]\s*\S{10,}\b/i, id: 'token_assignment', severity: 'medium' },
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

/**
 * Scan memory content for injection/exfiltration patterns AND secret leaks.
 * @param content the content to scan
 * @returns an explanation of what was blocked, or null when safe
 */
export function scanContent(content: string): string | null {
  if (content.length === 0) return null;
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} (possible injection).`;
    }
  }
  for (const { pattern, id } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content matches threat pattern '${id}'. Memory entries may be surfaced through search or prompt injection and must not contain injection or exfiltration payloads.`;
    }
  }
  for (const { pattern, id, severity } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory. Use an .env file or a secrets manager instead.`;
    }
  }
  return null;
}
