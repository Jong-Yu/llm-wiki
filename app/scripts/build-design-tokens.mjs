import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// No Electron, React or third-party runtime is needed for this design asset step.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const input = path.join(appRoot, 'design/tokens.json');
const output = path.join(appRoot, 'src/renderer/shared/theme');
const args = process.argv.slice(2);
const check = args.includes('--check');
const sourceIndex = args.indexOf('--source');
if (args.some((a, i) => !['--check', '--source'].includes(a) && !(sourceIndex >= 0 && i === sourceIndex + 1))) {
  throw new Error('Usage: node app/scripts/build-design-tokens.mjs [--check] [--source <prototype.html>]');
}
if (sourceIndex >= 0 && (!args[sourceIndex + 1] || args[sourceIndex + 1].startsWith('--'))) {
  throw new Error('--source requires an HTML path');
}

const raw = await readFile(input, 'utf8');
const manifest = JSON.parse(raw);
if (manifest.formatVersion !== 1 || !manifest.tokens || !manifest.source?.sha256) {
  throw new Error('Invalid token manifest');
}
if (sourceIndex >= 0) {
  const source = await readFile(path.resolve(args[sourceIndex + 1]));
  if (createHash('sha256').update(source).digest('hex') !== manifest.source.sha256) {
    throw new Error('Prototype changed: re-audit tokens before updating the recorded source hash');
  }
}

const entries = Object.entries(manifest.tokens);
const allowedTypes = new Set(['color', 'dimension', 'number', 'fontFamily', 'string', 'shadow', 'duration']);
const names = new Set();
const cssName = (name) => `--wiki-${name.replace(/[A-Z]/g, (s) => `-${s.toLowerCase()}`).replaceAll('.', '-')}`;
for (const [name, token] of entries) {
  if (!/^[a-z][\w]*(\.(?:[a-z][\w]*|\d+))+$/.test(name) || !allowedTypes.has(token.type)) {
    throw new Error(`Invalid token: ${name}`);
  }
  if (!['extracted', 'normalized', 'proposed'].includes(token.origin) || !token.source) {
    throw new Error(`Missing provenance: ${name}`);
  }
  if (names.has(cssName(name))) throw new Error(`CSS name collision: ${name}`);
  names.add(cssName(name));
}

function resolve(name, mode, trail = []) {
  const token = manifest.tokens[name];
  if (!token || trail.includes(name)) throw new Error(`Unknown/cyclic reference: ${[...trail, name].join(' -> ')}`);
  let value = token.value;
  if (typeof value === 'object' && value !== null) {
    if (!Object.hasOwn(value, 'light') || !Object.hasOwn(value, 'dark')) throw new Error(`Missing mode: ${name}`);
    value = value[mode];
  }
  const ref = typeof value === 'string' && /^\{([^}]+)\}$/.exec(value);
  if (ref) {
    if (manifest.tokens[ref[1]]?.type !== token.type) throw new Error(`Alias type mismatch: ${name}`);
    return resolve(ref[1], mode, [...trail, name]);
  }
  if (['dimension', 'number', 'duration'].includes(token.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid number: ${name}`);
  } else if (typeof value !== 'string' || /[;{}\n\r]/.test(value)) {
    throw new Error(`Invalid string: ${name}`);
  }
  if (token.type === 'color' && !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) throw new Error(`Invalid color: ${name}`);
  return value;
}

const values = Object.fromEntries(['light', 'dark'].map((mode) => [mode,
  Object.fromEntries(entries.map(([name]) => [name, resolve(name, mode)])),
]));
function cssValue(name, value) {
  const type = manifest.tokens[name].type;
  return type === 'dimension' ? `${value}px` : type === 'duration' ? `${value}ms` : String(value);
}
const generatedHash = createHash('sha256').update(raw).digest('hex');
const header = `Generated from app/design/tokens.json (SHA-256 ${generatedHash}). Do not edit.`;
const css = `/* ${header} */\n` + ['light', 'dark'].map((mode) => {
  const selectors = mode === 'light' ? '.wiki-theme, [data-wiki-theme="light"]' : '[data-wiki-theme="dark"]';
  return `${selectors} {\n  color-scheme: ${mode};\n${entries.map(([name]) => `  ${cssName(name)}: ${cssValue(name, values[mode][name])};`).join('\n')}\n}`;
}).join('\n\n') + '\n';
const ts = `// ${header}\n` +
  `export const designTokens = ${JSON.stringify(values, null, 2)} as const;\n\n` +
  `export type ThemeMode = keyof typeof designTokens;\n` +
  `export type TokenName = keyof typeof designTokens.light;\n\n` +
  `export const tokenVars = ${JSON.stringify(Object.fromEntries(entries.map(([name]) => [name, `var(${cssName(name)})`])), null, 2)} as const satisfies Record<TokenName, string>;\n`;
for (const [name, content] of [['tokens.css', css], ['tokens.ts', ts]]) {
  const dest = path.join(output, name);
  if (check) {
    if (await readFile(dest, 'utf8') !== content) throw new Error(`Stale generated output: ${dest}`);
  } else {
    await mkdir(output, { recursive: true });
    await writeFile(dest, content);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} ${entries.length} tokens, 2 modes, CSS + TypeScript${sourceIndex >= 0 ? ', prototype hash matched' : ''}.`);
