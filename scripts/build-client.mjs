/**
 * Build the prebuilt client bundle (client/client.js) from TS sources.
 *
 * The bundle runs in the dsh web GUI via `window.__ModuleLoader__.load`.
 * esbuild compiles client/src/*.ts to CJS with `react` externalized — the
 * emitted `require("react")` calls bind to the factory's `require` parameter
 * at load time (same contract as the shipped ui-* plugins). No bundler
 * transform touches the DOM globals (fetch/URLSearchParams/setTimeout).
 */
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['client/src/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: ['react'],
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

const code = result.outputFiles[0].text;

const banner = `/**
 * dsh-persona-memory — browser half ("记忆管理" settings page).
 *
 * AUTO-GENERATED from client/src/*.ts by scripts/build-client.mjs (esbuild).
 * Do not edit by hand — rebuild with \`npm run build:client\`.
 *
 * The page talks to the host through the /api/persona-memory/* route family
 * (registered by lib/admin.ts on the host \`webServer\` service).
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-memory',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
`;

const footer = `
    return module.exports;
  },
});
`;

writeFileSync('client/client.js', banner + code + footer);
console.log(`client/client.js rebuilt (${(banner + code + footer).length} bytes)`);
