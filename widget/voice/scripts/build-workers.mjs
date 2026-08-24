// Bundles every ui/workers/<name>.src.js into ui/public/workers/<name>.js.
//
// Metro cannot bundle Web Workers, so worker sources live outside the app tree
// and esbuild produces the files the page loads with
// new Worker('/workers/<name>.js', { type: 'module' }). Expo serves ui/public/
// at the web root.
//
// The ort runtime the Kokoro worker fetches at model-load time rides along
// under public/workers/transformers/ -- the build pinned inside
// @huggingface/transformers 3.8.1 (Kokoro worker:
// env.backends.onnx.wasm.wasmPaths = '/workers/transformers/'). It must stay
// in its own directory: the main-thread Moonshine ear runs onnxruntime-web
// 1.22.0 from /models/ort/ (vendored by fetch-models.mjs), the two ship
// same-named files that differ by hash (verified 2026-08-11), and the losing
// consumer of a mixed directory fails at session creation with an error that
// says nothing about versions. Nothing requests ort files from /workers/
// root -- the installed onnxruntime-web 1.27 package's dist is ~80MB of
// runtime assets no code path ever loads, so it is deliberately not copied.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = path.join(UI, 'workers');
const OUT_DIR = path.join(UI, 'public', 'workers');

// --- bundle ---------------------------------------------------------------

const sources = existsSync(SRC_DIR)
  ? readdirSync(SRC_DIR).filter((f) => f.endsWith('.src.js')).sort()
  : [];

if (sources.length === 0) {
  // Worker sources are written by other tasks; this script must be safe to run
  // before any of them exist.
  console.log(`build-workers: no *.src.js in ${SRC_DIR} yet — nothing to bundle.`);
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

const entryPoints = Object.fromEntries(
  sources.map((f) => [f.replace(/\.src\.js$/, ''), path.join(SRC_DIR, f)]),
);

const result = await build({
  entryPoints,
  outdir: OUT_DIR,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: false,
  sourcemap: 'linked',
  target: 'es2022',
  metafile: true,
});

console.log('bundled:');
for (const [out, meta] of Object.entries(result.metafile.outputs)) {
  if (out.endsWith('.map')) continue;
  console.log(`  ${path.relative(UI, path.resolve(out))}  ${fmt(meta.bytes)}`);
}

// Same size is not same file: same-named ort assets differ across versions by
// content (see header), and a size-matched stale binary next to a new loader
// is exactly the mixed pair that fails at session creation with no version
// hint. "up to date" therefore means same bytes — the size check ahead of
// each call is just the cheap short-circuit before hashing a few tens of MB.
const sameContent = (a, b) =>
  createHash('sha256').update(readFileSync(a)).digest('hex') ===
  createHash('sha256').update(readFileSync(b)).digest('hex');

// --- runtime assets ---------------------------------------------------------

// Only the ort-wasm-* files are runtime assets the bundles fetch at model-load
// time; everything else in those dist dirs is a library entry point that
// esbuild already inlined.
const RUNTIME = /^ort-wasm.*\.(wasm|mjs)$/;

const assetSets = [
  {
    pkg: '@huggingface/transformers',
    src: path.join(UI, 'node_modules', '@huggingface', 'transformers', 'dist'),
    dst: path.join(OUT_DIR, 'transformers'),
  },
];

console.log('runtime assets:');
for (const { pkg, src, dst } of assetSets) {
  if (!existsSync(src)) {
    console.warn(`  WARNING: ${src} missing — is ${pkg} installed? Skipped.`);
    continue;
  }
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src).filter((f) => RUNTIME.test(f)).sort()) {
    const from = path.join(src, f);
    const to = path.join(dst, f);
    const size = statSync(from).size;
    const had = existsSync(to) && statSync(to).size === size && sameContent(from, to);
    if (!had) copyFileSync(from, to);
    console.log(
      `  ${path.relative(UI, to)}  ${fmt(size)}  ${had ? 'up to date' : 'copied'}  (${pkg})`,
    );
  }
}

// --- runtime-imported vendor modules ----------------------------------------

// moonshine-js can't go through Metro at all (its rollup output holds a
// non-literal dynamic import Metro's transform rejects), so the page imports
// the package's self-contained ESM bundle natively at runtime from
// /vendor/ -- see ui/lib/moonshineLoader.js.
const VENDOR = [
  {
    pkg: '@moonshine-ai/moonshine-js',
    from: path.join(
      UI, 'node_modules', '@moonshine-ai', 'moonshine-js', 'dist', 'moonshine.min.js',
    ),
    to: path.join(UI, 'public', 'vendor', 'moonshine.min.js'),
  },
];

console.log('vendor modules:');
for (const { pkg, from, to } of VENDOR) {
  if (!existsSync(from)) {
    console.warn(`  WARNING: ${from} missing — is ${pkg} installed? Skipped.`);
    continue;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  const size = statSync(from).size;
  const had = existsSync(to) && statSync(to).size === size && sameContent(from, to);
  if (!had) copyFileSync(from, to);
  console.log(
    `  ${path.relative(UI, to)}  ${fmt(size)}  ${had ? 'up to date' : 'copied'}  (${pkg})`,
  );
}

function fmt(bytes) {
  return bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;
}
