import { Animated, Platform } from './rn-shim.js';

// Hazlie's voice: the Kokoro worker on one side, the speaker on the other.
//
// Everything audible passes through one AudioContext and one node chain --
// sources -> master gain -> analyser -> destination -- so pre-baked WAVs and
// live synthesis animate the eyes identically, and the volume intents scale
// both. The analyser sits AFTER the gain on purpose: the mouth tracks what is
// actually heard, not what was synthesised.
//
// WEB ONLY, like the rest of the voice layer. On native every call is a no-op
// rather than a crash, so callers never need to branch.
//
// Talking state comes from the playback queue (first chunk scheduled -> start;
// queue drained and last source ended -> end), never from RMS. RMS says how
// loud, not whether she owes more audio: sentence gaps and a muted volume
// would both misreport the turn.

const isWeb = Platform.OS === 'web';

// Bundled from ui/workers/tts-worker.src.js by `npm run build:workers`; Expo
// serves ui/public/ at the web root.
const WORKER_URL = '/workers/tts-worker.js';
// Pre-baked Kokoro lines from `npm run bake:voice` land in ui/public/voice/.
const VOICE_BASE = '/voice';

// Below this the analyser is reading room noise / DC, not her voice.
const TALK_RMS_THRESHOLD = 0.006;

export function createVoice(callbacks = {}, options = {}) {
  const {
    onTalkStart,
    onTalkEnd,
    onEnvelopeLive,
    onError,
  } = callbacks;
  const localOnly = options.localOnly === true;
  const requiredAssetNames = Array.isArray(options.requiredAssetNames)
    ? [...new Set(options.requiredAssetNames)]
    : [];

  // The live output envelope, published for the eyes to render as a waveform:
  // wideband level plus a low and a high band. Animated.Values so the 60fps
  // updates never touch React state.
  const level = new Animated.Value(0);
  const levelLow = new Animated.Value(0);
  const levelHigh = new Animated.Value(0);

  // False until the analyser has actually seen sound. The eyes must fall back
  // to the synthetic pulse while this is false: gating the waveform on the mere
  // PRESENCE of these values meant that if the analyser never produced a sample
  // -- suspended AudioContext, no Web Audio, output routed somewhere unreadable
  // -- `talking` rendered as a motionless ring, which is exactly the bug the
  // pulse fallback exists to prevent.
  let envelopeLive = false;

  if (!isWeb) {
    const noop = () => {};
    return {
      init: async () => {},
      sayAsset: async () => {},
      sayText: noop,
      openStream: () => ({ push: noop, end: noop }),
      stopAll: noop,
      setVolume: noop,
      destroy: noop,
      level,
      levelLow,
      levelHigh,
      get envelopeLive() {
        return envelopeLive;
      },
    };
  }

  let ctx = null;
  let master = null;
  let analyser = null;
  let lowAn = null;
  let highAn = null;
  let buf = null;
  let lowBuf = null;
  let highBuf = null;

  let worker = null;
  let initPromise = null;

  let volume = 1;
  let nextId = 1;
  // Synthesis jobs the worker still owes audio for. Non-empty means the turn
  // is not over even when every scheduled source has finished -- the gap
  // between sentences must not read as end-of-reply.
  const jobs = new Set();
  // sayAsset fetch/decode in flight, same role as jobs for the canned path.
  let pendingAssets = 0;
  // Bumped by stopAll; an asset decode that resolves under an old generation
  // has been barged in on and must not reach the speaker.
  let assetGen = 0;
  const activeSources = new Set();
  const decoded = new Map();
  // Where the next chunk starts. Scheduling each buffer at the previous one's
  // exact end is what makes per-sentence synthesis sound like one utterance.
  let nextStartTime = 0;
  let talking = false;
  let rafId = null;

  const fail = (m) => onError?.(m);

  const rmsOf = (an, b) => {
    an.getFloatTimeDomainData(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  };
  // Map raw RMS onto 0..1. Speech RMS sits low and spiky, so the curve is
  // scaled and softened rather than used raw, and the fall is slowed well
  // below the rise: instant decay makes a waveform look like it is flickering
  // out, while a slower release reads as a level meter settling.
  const shape = (rms) => Math.min(1, Math.sqrt(Math.max(0, rms) / 0.06));
  const smooth = (prev, next) =>
    next > prev ? prev + (next - prev) * 0.5 : prev + (next - prev) * 0.14;
  let lvl = 0;
  let lo = 0;
  let hi = 0;

  // Unlike the old per-session meter this loop is not permanent: the tab is
  // meant to run 24/7 and burning a rAF while she is silent buys nothing. It
  // runs from first scheduled audio until the smoothed values have settled
  // back to zero after the last source ends.
  const tick = () => {
    const rms = rmsOf(analyser, buf);

    if (rms > TALK_RMS_THRESHOLD && !envelopeLive) {
      // Once, the first time real sound is measured, so the eyes can switch
      // off the synthetic pulse and onto the real envelope.
      envelopeLive = true;
      onEnvelopeLive?.();
    }

    // Publish the envelope on Animated values rather than React state: these
    // change every frame, and setState at 60fps would re-render the whole
    // screen. setValue writes straight into the animation node.
    lvl = smooth(lvl, talking ? shape(rms) : 0);
    lo = smooth(lo, talking ? shape(rmsOf(lowAn, lowBuf)) : 0);
    hi = smooth(hi, talking ? shape(rmsOf(highAn, highBuf)) : 0);
    level.setValue(lvl);
    levelLow.setValue(lo);
    levelHigh.setValue(hi);

    if (!talking && lvl < 0.001 && lo < 0.001 && hi < 0.001) {
      lvl = lo = hi = 0;
      level.setValue(0);
      levelLow.setValue(0);
      levelHigh.setValue(0);
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  const ensureLoop = () => {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  };

  function maybeTalkEnd() {
    if (!talking) return;
    if (activeSources.size > 0 || jobs.size > 0 || pendingAssets > 0) return;
    talking = false;
    nextStartTime = 0;
    onTalkEnd?.();
  }

  function schedule(buffer) {
    // Created several async hops after the gesture, so it can arrive
    // suspended -- in which case playback silently never starts. sfx.js does
    // the same nudge for the same reason.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(master);
    const at = Math.max(ctx.currentTime + 0.005, nextStartTime);
    nextStartTime = at + buffer.duration;
    activeSources.add(src);
    src.onended = () => {
      activeSources.delete(src);
      maybeTalkEnd();
    };
    src.start(at);
    if (!talking) {
      talking = true;
      onTalkStart?.();
    }
    ensureLoop();
  }

  function handleWorkerMessage({ data: msg }) {
    switch (msg.type) {
      case 'ready':
        initPromise?.resolve?.();
        break;
      case 'chunk': {
        // An id no longer in jobs was cancelled by stopAll after the worker
        // had already posted; late chunks must not resurrect the turn.
        if (!jobs.has(msg.id) || !msg.audio?.length) break;
        // createBuffer at the worker's rate; the source node resamples to the
        // device rate on its own.
        const buffer = ctx.createBuffer(1, msg.audio.length, msg.sampleRate);
        buffer.copyToChannel(msg.audio, 0);
        schedule(buffer);
        break;
      }
      case 'end':
        jobs.delete(msg.id);
        maybeTalkEnd();
        break;
      case 'error':
        if (msg.id != null) jobs.delete(msg.id);
        else initPromise?.reject?.(new Error(msg.message));
        fail(msg.message);
        maybeTalkEnd();
        break;
      default:
        break;
    }
  }

  function loadAsset(name) {
    let p = decoded.get(name);
    if (!p) {
      p = fetch(`${VOICE_BASE}/${name}.wav`)
        .then((res) => {
          if (!res.ok) throw new Error(`fetch failed (${res.status})`);
          return res.arrayBuffer();
        })
        .then((ab) => ctx.decodeAudioData(ab));
      // Failures are not cached (a mid-bake 404 should not be permanent), and
      // this handler keeps a swallowed preload from becoming an unhandled
      // rejection.
      p.catch(() => decoded.delete(name));
      decoded.set(name, p);
    }
    return p;
  }

  // Decode every baked line at init so sayAsset is scheduling, not fetching --
  // the deterministic tier's ~0ms time-to-first-audio is this cache.
  async function preloadAssets(required = false) {
    try {
      const res = await fetch(`${VOICE_BASE}/manifest.json`);
      if (!res.ok) throw new Error(String(res.status));
      const manifest = await res.json();
      const names = Object.keys(manifest);
      if (required && names.length === 0) throw new Error('empty manifest');
      if (required) {
        const missing = requiredAssetNames.filter((name) => !(name in manifest));
        if (missing.length) throw new Error('incomplete manifest');
      }
      if (required) await Promise.all(names.map((name) => loadAsset(name)));
      else await Promise.all(names.map((name) => loadAsset(name).catch(() => {})));
    } catch (err) {
      if (required) throw new Error('local voice assets missing', { cause: err });
      // Not fatal: the pipeline runs without baked lines, they are just slow
      // (sayAsset errors surface per call).
      console.warn('voice: no baked assets found -- run `npm run bake:voice`');
    }
  }

  function requireInit() {
    if (worker) return true;
    fail('voice.init() has not run');
    return false;
  }

  async function init() {
    if (initPromise) return initPromise.promise;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      // Reject rather than resolve: a connect() that proceeded past init()
      // would reach status 'live' with a voice that can never speak.
      fail('Web Audio unavailable');
      throw new Error('Web Audio unavailable');
    }
    ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    master = ctx.createGain();
    master.gain.value = volume;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    buf = new Float32Array(analyser.fftSize);

    // Two band-limited taps alongside the wideband meter, so the eyes can move
    // independently the way two bars of a waveform display do. Speech puts most
    // of its energy low (vowels) with bursts high (consonants), so the pair
    // reads as one voice rather than as two things moving in lockstep.
    const lowBand = ctx.createBiquadFilter();
    lowBand.type = 'lowpass';
    lowBand.frequency.value = 500;
    const highBand = ctx.createBiquadFilter();
    highBand.type = 'highpass';
    highBand.frequency.value = 1400;
    lowAn = ctx.createAnalyser();
    lowAn.fftSize = 512;
    highAn = ctx.createAnalyser();
    highAn.fftSize = 512;
    master.connect(lowBand).connect(lowAn);
    master.connect(highBand).connect(highAn);
    lowBuf = new Float32Array(lowAn.fftSize);
    highBuf = new Float32Array(highAn.fftSize);

    let resolve;
    let reject;
    const workerPromise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = handleWorkerMessage;
    // Publish the promise owner before the worker can answer. A cached worker
    // may post `ready` in the next task; leaving initPromise null until after
    // postMessage would lose that signal and hang init forever.
    const assetsPromise = preloadAssets(localOnly);
    const promise = localOnly
      ? Promise.all([workerPromise, assetsPromise]).then(() => undefined)
      : workerPromise;
    initPromise = { promise, resolve, reject };
    worker.onerror = (e) => {
      initPromise?.reject?.(new Error(e.message ?? 'tts worker failed'));
      fail(e.message ?? 'tts worker failed');
    };
    worker.postMessage({ type: 'init', localOnly });
    return promise;
  }

  /** Play a pre-baked line through the same analyser path as live synthesis. */
  async function sayAsset(name) {
    if (!requireInit()) return;
    const gen = assetGen;
    pendingAssets += 1;
    try {
      const buffer = await loadAsset(name);
      if (gen !== assetGen) return; // barged in on while decoding
      schedule(buffer);
    } catch (e) {
      fail(`voice asset "${name}": ${e?.message ?? e}`);
    } finally {
      if (gen === assetGen) {
        pendingAssets -= 1;
        maybeTalkEnd();
      }
    }
  }

  /** Synthesize a complete short text (computed values: the time, a timer). */
  function sayText(text) {
    if (!requireInit()) return;
    const id = nextId++;
    jobs.add(id);
    worker.postMessage({ type: 'say', id, text });
  }

  /** Feed LLM deltas as they stream; speech starts on the first sentence. */
  function openStream() {
    if (!requireInit()) return { push: () => {}, end: () => {} };
    const id = nextId++;
    jobs.add(id);
    worker.postMessage({ type: 'stream-start', id });
    return {
      push(delta) {
        // jobs.has(id) goes false on stopAll: deltas from an aborted LLM
        // stream must not re-open a cancelled utterance.
        if (jobs.has(id)) worker.postMessage({ type: 'stream-delta', id, text: delta });
      },
      end() {
        if (jobs.has(id)) worker.postMessage({ type: 'stream-end', id });
      },
    };
  }

  /** The barge-in path: silence everything now, forget everything owed. */
  function stopAll() {
    assetGen += 1;
    pendingAssets = 0;
    jobs.clear();
    worker?.postMessage({ type: 'cancel' });
    for (const src of activeSources) {
      // Detach before stopping: the onended storm from a mass stop must not
      // re-run maybeTalkEnd per node after state is already cleared.
      src.onended = null;
      try {
        src.stop(0);
      } catch {
        // already ended
      }
    }
    activeSources.clear();
    nextStartTime = 0;
    if (talking) {
      talking = false;
      onTalkEnd?.();
    }
  }

  /** 0..1 master volume, for the volume intents. */
  function setVolume(v01) {
    volume = Math.max(0, Math.min(1, Number(v01) || 0));
    if (!master) return;
    // A short ramp rather than a jump: stepping gain mid-waveform clicks.
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(volume, t + 0.03);
  }

  /** disconnect()'s teardown: silence now, then unmake everything init
   *  built. The worker is terminated -- a mid-sentence Kokoro inference dies
   *  with it -- and the AudioContext closed; after this, a new createVoice()
   *  is required, not another init(). */
  function destroy() {
    stopAll();
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lvl = lo = hi = 0;
    level.setValue(0);
    levelLow.setValue(0);
    levelHigh.setValue(0);
    // A connect() still awaiting init() must be released, not left hanging.
    initPromise?.reject?.(new Error('voice destroyed'));
    initPromise = null;
    worker?.terminate();
    worker = null;
    decoded.clear();
    ctx?.close().catch(() => {});
    ctx = null;
  }

  return {
    init,
    sayAsset,
    sayText,
    openStream,
    stopAll,
    setVolume,
    destroy,
    level,
    levelLow,
    levelHigh,
    // Consumers must fall back to the synthetic pulse until this is true.
    get envelopeLive() {
      return envelopeLive;
    },
  };
}

export default createVoice;
