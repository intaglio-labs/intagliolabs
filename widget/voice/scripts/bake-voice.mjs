import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KokoroTTS } from 'kokoro-js';
// CANNED_LINES: { [name]: exact spoken text } -- the deterministic tier's
// fixed lines. Names become /voice/<name>.wav, so they must be filename-safe.
import { CANNED_LINES } from '../intents/catalog.mjs';
import { encodeWavPcm16 } from '../lib/wav.mjs';

// Pre-bake every fixed deterministic line with the same model and voice the
// live path uses, so canned speech and streamed speech are one voice. Baked
// WAVs are the deterministic tier's whole latency story: ~0ms to first audio
// instead of a live synthesis.
//
// Re-run after any CANNED_LINES edit. manifest.json records the exact text
// each WAV was baked from, so a stale bake is detectable by diffing it
// against the catalog rather than by listening.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'voice');

const entries = Object.entries(CANNED_LINES);
if (entries.length === 0) {
  console.error('bake-voice: CANNED_LINES is empty; nothing to bake');
  process.exit(1);
}
for (const [name, text] of entries) {
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    console.error(`bake-voice: line name "${name}" is not filename-safe ([a-z0-9_-] only)`);
    process.exit(1);
  }
  if (typeof text !== 'string' || text.trim() === '') {
    console.error(`bake-voice: line "${name}" has no text`);
    process.exit(1);
  }
}

console.log(
  `bake-voice: loading ${MODEL_ID} (q8) -- first run downloads ~90MB from ` +
    'Hugging Face into the transformers.js cache; later runs are local.'
);

// 'cpu' (onnxruntime-node) is the only device transformers' Node build
// accepts on this platform -- 'wasm' is a browser-build device and
// from_pretrained throws on it under Node. Same weights and q8 quantization
// as the worker's wasm path, so canned and live speech stay one voice.
const tts = await KokoroTTS.from_pretrained(MODEL_ID, { device: 'cpu', dtype: 'q8' });

fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = {};
for (const [name, text] of entries) {
  const t0 = performance.now();
  const audio = await tts.generate(text, { voice: VOICE });
  const wav = encodeWavPcm16(audio.audio, audio.sampling_rate);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.wav`), wav);
  manifest[name] = text;
  const ms = Math.round(performance.now() - t0);
  const secs = (audio.audio.length / audio.sampling_rate).toFixed(2);
  console.log(`  ${name}.wav  ${ms}ms synth  ${secs}s audio  "${text}"`);
}

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

// Renamed or removed lines leave orphaned WAVs behind; a stale file makes a
// dead asset name keep "working". Flagged rather than deleted so a human
// decides.
const orphans = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.wav') && !(f.slice(0, -4) in manifest));
for (const f of orphans) {
  console.warn(`bake-voice: orphaned ${f} is not in CANNED_LINES -- delete it?`);
}

console.log(`bake-voice: ${entries.length} lines -> ${OUT_DIR}`);
