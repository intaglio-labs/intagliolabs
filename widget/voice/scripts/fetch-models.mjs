// Vendors the STT/TTS model files into ui/public/models/ so the voice pipeline
// runs with the network cable conceptually cut.
//
// Every URL, path, byte count and SHA-256 below was read out of the installed
// packages or the complete known-good local asset set and pinned on 2026-08-11.
// A matching byte count is not enough: every existing, copied and downloaded
// file is hash-verified before this script accepts it.
//
// Moonshine (@moonshine-ai/moonshine-js 0.1.29, src/model.ts + constants.ts):
//   requests  <Settings.BASE_ASSET_PATH.MOONSHINE> + 'model/tiny/quantized/' +
//   {encoder_model.onnx, decoder_model_merged.onnx}. "streaming-tiny" in the
//   plan is not a separate model — streaming is the same tiny model run with
//   useVAD=false. The base path is a mutable global, so the ear worker points
//   it at the vendored copy:
//     Settings.BASE_ASSET_PATH.MOONSHINE = '/models/moonshine/';
//     Settings.BASE_ASSET_PATH.SILERO_VAD = '/models/vad/';
//   The npm package ships the tiny model inside dist/, byte-identical in size
//   to download.moonshine.ai, so we copy locally and only download as a
//   fallback.
//
// Kokoro (kokoro-js 1.2.1 → @huggingface/transformers): transformers.js CAN
//   serve from a local path — the voice worker sets
//     env.localModelPath = '/models/';
//     env.allowLocalModels = true;
//   and from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX') resolves under
//   ui/public/models/. The worker disables allowRemoteModels in `localOnly`
//   mode, which /home uses: a missing file fails before mic
//   capture rather than reaching Hugging Face. A controlled development
//   caller may explicitly opt out. dtype→file:
//   fp32→model.onnx (the WebGPU path), q8→model_quantized.onnx (the WASM
//   fallback); both vendored by default.
//
//   ONE HONEST CAVEAT: kokoro-js's browser build hardcodes the voice URL
//   (https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/
//   voices/af_heart.bin) with no env override — dist/kokoro.js caches it under
//   caches.open('kokoro-voices'). voices/af_heart.bin is vendored here anyway;
//   the voice worker primes the 'kokoro-voices' Cache API entry from this
//   vendored copy before constructing KokoroTTS. In localOnly mode, a missing
//   local voice fails closed rather than touching the hardcoded remote URL.
//
// HF_TOKEN is honored for huggingface.co downloads (the Kokoro repo is public;
// the token only helps with rate limits). Downloads are resumable: partial
// files live at <dest>.part and a re-run continues from where it stopped.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const UI = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(UI, 'public', 'models');
const NM = path.join(UI, 'node_modules');

const MOONSHINE_CDN = 'https://download.moonshine.ai/';
// Exact pinned URL from moonshine-js Settings.BASE_ASSET_PATH.SILERO_VAD.
const VAD_CDN = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/';
// The ORT version baked INSIDE moonshine.min.js (its default ONNX_RUNTIME
// base path), NOT the locally installed onnxruntime-web 1.27 -- a
// version-skewed loader/.wasm pair fails at session create.
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_CDN = `https://huggingface.co/${KOKORO_REPO}/resolve/main/`;

// The voice worker has exactly two execution paths: fp32/WebGPU and q8/WASM.
// Do not advertise unused quantizations without first fetching them from the
// pinned source, independently verifying them, and adding their digest here.
const KOKORO_DTYPES = {
  fp32: {
    file: 'model.onnx',
    size: 325532232,
    sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
  },
  q8: {
    file: 'model_quantized.onnx',
    size: 92361116,
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
  },
};

const dtypeArg = process.argv
  .find((a) => a.startsWith('--dtype='))
  ?.slice('--dtype='.length) ?? 'fp32,q8';
const dtypes = dtypeArg.split(',').map((s) => s.trim()).filter(Boolean);
for (const d of dtypes) {
  if (!KOKORO_DTYPES[d]) {
    console.error(
      `fetch-models: unknown dtype '${d}'. Known: ${Object.keys(KOKORO_DTYPES).join(', ')}`
    );
    process.exit(1);
  }
}

const moonshineLocal = path.join(
  NM,
  '@moonshine-ai',
  'moonshine-js',
  'dist',
  'model',
  'tiny',
  'quantized'
);

const assets = [
  {
    dest: 'moonshine/model/tiny/quantized/encoder_model.onnx',
    url: `${MOONSHINE_CDN}model/tiny/quantized/encoder_model.onnx`,
    size: 7937661,
    sha256: 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a',
    local: path.join(moonshineLocal, 'encoder_model.onnx'),
  },
  {
    dest: 'moonshine/model/tiny/quantized/decoder_model_merged.onnx',
    url: `${MOONSHINE_CDN}model/tiny/quantized/decoder_model_merged.onnx`,
    size: 20243286,
    sha256: 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367',
    local: path.join(moonshineLocal, 'decoder_model_merged.onnx'),
  },
  // Moonshine's bundled VAD requests these names off its SILERO_VAD base
  // path (grep the dist bundle for baseAssetPath+). The Transcriber
  // constructs AudioNodeVAD with model:"v5", which loads silero_vad_v5.onnx;
  // legacy stays vendored for the non-streaming default.
  {
    dest: 'vad/silero_vad_legacy.onnx',
    url: `${VAD_CDN}silero_vad_legacy.onnx`,
    size: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
  },
  {
    dest: 'vad/silero_vad_v5.onnx',
    url: `${VAD_CDN}silero_vad_v5.onnx`,
    size: 2327524,
    sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
  },
  {
    dest: 'vad/vad.worklet.bundle.min.js',
    url: `${VAD_CDN}vad.worklet.bundle.min.js`,
    size: 2642,
    sha256: 'c187b8546aa8e8d91c8cbfccdd00407ca44724e7f3369770a5524efc76d441a0',
  },
  // ORT runtime for the ear, at moonshine's own pinned version -- lib/ear.js
  // probes /models/ort/ and stays on the jsdelivr default when absent.
  // moonshine's baked ort is the jsep build, so the .jsep pair is what the
  // ear actually loads (and what ear.js probes); the plain pair is vendored
  // as insurance for a future moonshine that drops jsep, not because
  // anything requests it today.
  {
    dest: 'ort/ort-wasm-simd-threaded.wasm',
    url: `${ORT_CDN}ort-wasm-simd-threaded.wasm`,
    size: 11210254,
    sha256: '71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4',
  },
  {
    dest: 'ort/ort-wasm-simd-threaded.mjs',
    url: `${ORT_CDN}ort-wasm-simd-threaded.mjs`,
    size: 20856,
    sha256: '30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8',
  },
  {
    dest: 'ort/ort-wasm-simd-threaded.jsep.wasm',
    url: `${ORT_CDN}ort-wasm-simd-threaded.jsep.wasm`,
    size: 21872216,
    sha256: 'b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368',
  },
  {
    dest: 'ort/ort-wasm-simd-threaded.jsep.mjs',
    url: `${ORT_CDN}ort-wasm-simd-threaded.jsep.mjs`,
    size: 44677,
    sha256: '1cbcba8f2c769c1eecbab66a1b1e55ef11704515bf4306373e3db3c37cf6dcd8',
  },
  {
    dest: `${KOKORO_REPO}/config.json`,
    url: `${KOKORO_CDN}config.json`,
    size: 44,
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  },
  {
    dest: `${KOKORO_REPO}/tokenizer.json`,
    url: `${KOKORO_CDN}tokenizer.json`,
    size: 3497,
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  },
  {
    dest: `${KOKORO_REPO}/tokenizer_config.json`,
    url: `${KOKORO_CDN}tokenizer_config.json`,
    size: 113,
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  },
  {
    dest: `${KOKORO_REPO}/voices/af_heart.bin`,
    url: `${KOKORO_CDN}voices/af_heart.bin`,
    size: 522240,
    sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
    // kokoro-js ships every voice in its npm package for the Node path.
    local: path.join(NM, 'kokoro-js', 'voices', 'af_heart.bin'),
  },
  ...dtypes.map((d) => ({
    dest: `${KOKORO_REPO}/onnx/${KOKORO_DTYPES[d].file}`,
    url: `${KOKORO_CDN}onnx/${KOKORO_DTYPES[d].file}`,
    size: KOKORO_DTYPES[d].size,
    sha256: KOKORO_DTYPES[d].sha256,
  })),
];

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function integrity(file, size, expectedSha256) {
  if (!existsSync(file)) return { ok: false, reason: 'missing' };
  const gotSize = statSync(file).size;
  if (gotSize !== size) {
    return { ok: false, reason: `size ${gotSize}, expected ${size}` };
  }
  const gotSha256 = await sha256(file);
  if (gotSha256 !== expectedSha256) {
    return { ok: false, reason: `SHA-256 ${gotSha256}, expected ${expectedSha256}` };
  }
  return { ok: true };
}

function remediation(file) {
  return `Move ${file} aside, inspect it, then re-run; it was not deleted automatically.`;
}

async function download(url, dest, size, expectedSha256) {
  const part = `${dest}.part`;
  let start = existsSync(part) ? statSync(part).size : 0;
  if (start > size) {
    throw new Error(
      `oversized partial file ${part}: got ${start}, expected at most ${size}. ` +
        remediation(part)
    );
  }
  // A prior run can finish the bytes but be interrupted before rename. Verify
  // and promote that complete partial without contacting the network.
  if (start === size) {
    const complete = await integrity(part, size, expectedSha256);
    if (!complete.ok) {
      throw new Error(
        `integrity mismatch for ${part}: ${complete.reason}. ${remediation(part)}`
      );
    }
    renameSync(part, dest);
    return;
  }
  const headers = {};
  if (process.env.HF_TOKEN && new URL(url).hostname.endsWith('huggingface.co')) {
    headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  }
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers });
  // A host that ignores Range answers 200 with the whole body; restart cleanly
  // rather than appending a second copy.
  if (res.status === 200) start = 0;
  else if (res.status !== 206) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body),
    createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }),
  );
  const got = statSync(part).size;
  if (got !== size) {
    throw new Error(
      `size mismatch for ${part}: got ${got}, expected ${size}. ${remediation(part)}`,
    );
  }
  const gotSha256 = await sha256(part);
  if (gotSha256 !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${part}: got ${gotSha256}, expected ${expectedSha256}. ` +
        remediation(part)
    );
  }
  renameSync(part, dest);
}

let failures = 0;
for (const { dest, url, size, sha256: expectedSha256, local } of assets) {
  const out = path.join(OUT, dest);
  const rel = path.relative(UI, out);
  const existing = await integrity(out, size, expectedSha256);
  if (existing.ok) {
    console.log(`  verified  ${rel}`);
    continue;
  }
  if (existing.reason !== 'missing') {
    failures += 1;
    console.log(`  FAILED    ${rel}: ${existing.reason}. ${remediation(out)}`);
    continue;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  if (local && existsSync(local)) {
    const source = await integrity(local, size, expectedSha256);
    if (!source.ok) {
      failures += 1;
      console.log(
        `  FAILED    ${path.relative(UI, local)}: ${source.reason}. ${remediation(local)}`
      );
      continue;
    }
    try {
      copyFileSync(local, out);
      const copied = await integrity(out, size, expectedSha256);
      if (!copied.ok) throw new Error(copied.reason);
      console.log(`  copied    ${rel}  (verified from node_modules)`);
      continue;
    } catch (err) {
      failures += 1;
      console.log(
        `  FAILED    ${rel}: copy verification failed: ${err.message}. ${remediation(out)}`
      );
      continue;
    }
  }
  try {
    process.stdout.write(
      `  fetching  ${rel}${size ? `  (${(size / 1e6).toFixed(1)} MB)` : ''} ...`
    );
    await download(url, out, size, expectedSha256);
    console.log(' verified');
  } catch (err) {
    failures += 1;
    console.log(` FAILED: ${err.message}`);
  }
}

if (failures > 0) {
  console.error(
    `\nfetch-models: ${failures} asset(s) failed integrity verification. ` +
      'No mismatched file was deleted or replaced.'
  );
  process.exit(1);
}

console.log(`
All model assets vendored under ${path.relative(UI, OUT)}/.

Runtime wiring (in the audio modules, not here):
  Moonshine ear   Settings.BASE_ASSET_PATH.MOONSHINE  = '/models/moonshine/'
                  Settings.BASE_ASSET_PATH.SILERO_VAD = '/models/vad/'
                  Settings.BASE_ASSET_PATH.ONNX_RUNTIME = '/models/ort/'  (1.22.0, matching moonshine's baked loader)
  Kokoro voice    env.localModelPath = '/models/'; env.allowLocalModels = true;
                  /home sets localOnly, which disables remote model fallback
                  and requires the baked voice cache to prime from
                  voices/af_heart.bin before microphone capture.`);
