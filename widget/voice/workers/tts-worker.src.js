import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { env } from '@huggingface/transformers';

// Kokoro-82M in a module worker: synthesis off the main thread so the eye
// animations never contend with it. Bundled by scripts/build-workers.mjs to
// /workers/tts-worker.js; the page loads it with { type: 'module' }.
//
// Protocol (in): {type:'init'}
//                {type:'say', id, text}
//                {type:'stream-start', id} / {type:'stream-delta', id, text} /
//                {type:'stream-end', id}
//                {type:'cancel'}
// Protocol (out): {type:'ready', device}
//                 {type:'chunk', id, audio: Float32Array (transferred), sampleRate}
//                 {type:'end', id}
//                 {type:'error', id?, message}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';

// Contracts with the sibling build scripts, so nothing here touches a
// non-localhost socket once `npm run build:workers` and `npm run fetch:models`
// have run: ort wasm binaries are served from /workers/transformers/ (the
// copy that matches the transformers.js pinned inside this bundle -- the one
// under /models/ort/ belongs to the main-thread Moonshine ear and differs by
// hash), and model files resolve under /models/. Remote stays allowed as a
// fallback (allowRemoteModels keeps its default) so a static-served page
// still runs before fetch:models has vendored anything in controlled dev. The
// product sends localOnly=true, which disables that fallback and fails
// closed before a voice session becomes live.
env.backends.onnx.wasm.wasmPaths = '/workers/transformers/';
env.localModelPath = '/models/';
env.allowLocalModels = true;

// kokoro-js hardcodes the voice URL to huggingface.co with no env override,
// but checks the 'kokoro-voices' Cache API bucket first. Priming that bucket
// with the vendored copy keeps the voice load local too; if the vendored file
// is missing this silently leaves kokoro-js's own HF fetch-and-cache path.
async function primeVoiceCache(required = false) {
  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${VOICE}.bin`;
  try {
    const cache = await caches.open('kokoro-voices');
    const local = await fetch(`/models/${MODEL_ID}/voices/${VOICE}.bin`);
    // Dev servers answer unknown paths with the SPA's index.html and a 200,
    // and this Cache API bucket persists across reloads -- caching that page
    // would feed HTML bytes to the voice loader forever, even after the real
    // file is vendored. Same guard as lib/ear.js's asset probe.
    const html = (local.headers.get('content-type') || '').includes('text/html');
    if (local.ok && !html) {
      await cache.put(url, local);
      return;
    }
    if (required) throw new Error('local Kokoro voice missing');
    if (await cache.match(url)) return;
  } catch (err) {
    if (required) throw err;
    // no Cache API in this context; kokoro-js will warn on its own
  }
}

let tts = null;
let ready = null;
// Bumped by cancel. A synthesis awaiting inside tts.stream() cannot be
// aborted mid-inference, so cancellation is: close the splitters (which ends
// the generators), then discard anything that resolves under an old
// generation. Nothing stale ever reaches the speaker.
let generation = 0;
// One job at a time. Two concurrent stream() loops would interleave their
// model calls and their chunks; a promise chain keeps utterance order.
let queue = Promise.resolve();
// Open splitters by job id, so cancel can close them all -- an open streaming
// splitter whose stream-end never arrives would otherwise block the queue
// forever.
const splitters = new Map();

async function load(localOnly = false) {
  env.allowRemoteModels = !localOnly;
  await primeVoiceCache(localOnly);
  // The adapter is probed BEFORE any webgpu session attempt: transformers
  // caches its first InferenceSession.create promise even when it rejects,
  // so a doomed webgpu try would poison the wasm retry with the webgpu
  // error and there would be no safe landing in this worker at all.
  // requestAdapter never touches that cache; navigator.gpu existing while
  // the adapter is null is the common failure (headless, GPU-blocklisted).
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (adapter) {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL_ID, { device: 'webgpu', dtype: 'fp32' });
        return 'webgpu';
      } catch {
        // fall through to wasm
      }
    }
  }
  // q8-on-wasm is the documented CPU shape and the safe landing.
  tts = await KokoroTTS.from_pretrained(MODEL_ID, { device: 'wasm', dtype: 'q8' });
  return 'wasm';
}

function init(localOnly = false) {
  if (!ready) {
    ready = load(localOnly).then(
      (device) => self.postMessage({ type: 'ready', device }),
      (e) => {
        ready = null; // a failed load may be retried with another init
        self.postMessage({ type: 'error', message: e?.message ?? String(e) });
      }
    );
  }
  return ready;
}

// Consume one utterance's splitter through Kokoro sentence by sentence, so
// audio for the first sentence plays while later ones are still synthesising.
function enqueue(id, splitter) {
  const gen = generation;
  queue = queue.then(async () => {
    try {
      if (!ready) throw new Error('tts worker used before init');
      await ready;
      if (gen !== generation) return;
      for await (const { audio } of tts.stream(splitter, { voice: VOICE })) {
        if (gen !== generation) return;
        const samples = audio.audio;
        self.postMessage(
          { type: 'chunk', id, audio: samples, sampleRate: audio.sampling_rate },
          [samples.buffer]
        );
      }
      if (gen !== generation) return;
      splitters.delete(id);
      self.postMessage({ type: 'end', id });
    } catch (e) {
      splitters.delete(id);
      if (gen === generation) {
        self.postMessage({ type: 'error', id, message: e?.message ?? String(e) });
      }
    }
  });
}

self.onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case 'init':
      init(msg.localOnly === true);
      break;
    case 'say': {
      // Same splitter path as streaming: a multi-sentence line starts
      // speaking on its first sentence instead of after the whole synth.
      const splitter = new TextSplitterStream();
      splitters.set(msg.id, splitter);
      splitter.push(msg.text ?? '');
      splitter.close();
      enqueue(msg.id, splitter);
      break;
    }
    case 'stream-start': {
      const splitter = new TextSplitterStream();
      splitters.set(msg.id, splitter);
      enqueue(msg.id, splitter);
      break;
    }
    case 'stream-delta':
      splitters.get(msg.id)?.push(msg.text ?? '');
      break;
    case 'stream-end':
      splitters.get(msg.id)?.close();
      break;
    case 'cancel':
      generation += 1;
      for (const splitter of splitters.values()) {
        try { splitter.close(); } catch {}
      }
      splitters.clear();
      break;
    default:
      break;
  }
};
