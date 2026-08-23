import { Platform } from './rn-shim.js';

import { createUtteranceTracker } from './earText.mjs';
import { loadMoonshine } from './moonshineLoader.js';

// The ear: mic -> Silero VAD gate -> Moonshine streaming STT -> one turn per
// VAD-bounded utterance.
//
// NO WAKE WORD. Pressing WAKE is already the explicit "start listening"
// gesture; once the session is live, the first thing said starts a turn --
// no spoken keyword required on top of the button. Wake-word text matching
// (fuzzy phonetic matching against Moonshine's transcript) was tried and
// removed: Moonshine-tiny does not reliably transcribe short wake phrases
// ("Hazlie", then "hey" both mis-transcribed in real testing), so gating
// every turn on it meant turns silently failed to start.
//
// WEB ONLY, like the rest of the voice layer: it needs getUserMedia and Web
// Audio. On native, start() reports an error instead of half-working.
//
// PRIVACY. There is no per-utterance gate anymore -- the WAKE/SLEEP button
// pair is the only consent boundary. Nothing is captured before WAKE or
// after SLEEP, but everything said while live becomes a turn and reaches the
// router/LLM, not just utterances addressed to her by name.
//
// MAIN THREAD, deliberately. The plan preferred Moonshine in a Web Worker fed
// by an AudioWorklet, but moonshine-js 0.1.29 cannot be split that way: its
// Transcriber constructs an AudioContext and takes audio ONLY as a
// MediaStream wired into its bundled AudioNodeVAD -- there is no API that
// accepts raw frames, and neither AudioContext nor MediaStream exists in a
// worker. The VAD isn't importable on its own either (the package's
// @ricky0123/vad-web dependency is a broken file: link; the fork lives only
// inside moonshine.min.js, unexported). Running bare MoonshineModel in a
// worker would mean rebuilding VAD, streaming buffers, and endpointing
// against guessed Silero tensor shapes. So the supported main-thread path it
// is; inference is onnxruntime WASM. If it visibly janks the eyes, the
// pre-planned exit is the sherpa-onnx/localhost tier, not a deeper fork.
//
// Endpointing: the VAD's trailing-silence redemption IS the endpoint. The
// bundle ships v5 defaults (24 frames = 768ms) with no constructor knob, but
// its property names survive minification and options merge live, so
// redemptionMs is applied after load. onSpeechEnd then arms a short grace
// window purely so the endpoint commit's inference can land; the commit's
// arrival finalizes early, the timer is the fallback.

const isWeb = Platform.OS === 'web';

export const MOONSHINE_MODEL = 'model/tiny';
const VAD_FRAME_MS = 32; // Silero v5 frame: 512 samples at 16kHz
export const ENDPOINT_COMMIT_GRACE_MS = 350; // covers the trailing commit's inference
export const DEFAULT_REDEMPTION_MS = 500;

// Model assets resolve against Settings.BASE_ASSET_PATH, whose library default
// is a CDN. `localOnly` (used by /home) refuses to acquire the mic
// unless every required local file is present. The opt-out remains available
// only for controlled development.
const VENDORED_ASSETS = [
  ['MOONSHINE', '/models/moonshine/', [
    'model/tiny/quantized/encoder_model.onnx',
    'model/tiny/quantized/decoder_model_merged.onnx',
  ]],
  // moonshine.min.js's inlined ort 1.22 is the jsep build: the .jsep pair is
  // the only wasm/mjs pair it ever requests (the plain filenames appear
  // nowhere in the bundle), so presence is probed on what will be fetched.
  ['ONNX_RUNTIME', '/models/ort/', [
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
  ]],
  ['SILERO_VAD', '/models/vad/', [
    'silero_vad_v5.onnx',
    'vad.worklet.bundle.min.js',
  ]],
];

async function assetPresent(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // Dev servers answer unknown paths with the SPA's index.html and a 200,
    // so a 200 alone does not prove the asset exists.
    return res.ok && !(res.headers.get('content-type') || '').includes('text/html');
  } catch {
    return false;
  }
}

async function pointAtVendoredAssets(Settings, { localOnly = false } = {}) {
  const groups = await Promise.all(
    VENDORED_ASSETS.map(async ([key, base, files]) => {
      const found = await Promise.all(files.map((f) => assetPresent(base + f)));
      const complete = found.every(Boolean);
      if (complete) Settings.BASE_ASSET_PATH[key] = base;
      return { key, complete };
    })
  );
  if (localOnly) {
    const missing = groups.filter((g) => !g.complete).map((g) => g.key);
    if (missing.length) {
      throw new Error(`local ear assets missing: ${missing.join(', ')}`);
    }
  }
}

/**
 * createEar(callbacks, options) ->
 *   { start, stop, setSuppressed, destroy }
 *
 * callbacks: {
 *   onReady()                    models loaded, first start only
 *   onMicLive(boolean)           actual OS capture state; observer is fail-open
 *   onWake({ commandPrefix })    a turn started; prefix = whatever was said in this update
 *   onPartial(text)              mid-turn: the command text so far
 *   onFinal(text)                endpoint fired; the full utterance ('' if nothing was said)
 *   onSpeechStart()/onSpeechEnd() raw VAD edges, turn or not
 *   onError(message)
 * }
 * options: {
 *   redemptionMs = 500,            trailing silence before endpoint (spec 400-600)
 *   localOnly = false              fail before mic capture if any model asset is absent
 * }
 */
export function createEar(callbacks = {}, options = {}) {
  const cb = callbacks;
  const emit = (name, ...args) => {
    if (typeof cb[name] === 'function') cb[name](...args);
  };

  if (!isWeb) {
    return {
      start() {
        emit('onError', 'the ear is web-only: native has no getUserMedia or Web Audio here');
        return false;
      },
      stop() {},
      setSuppressed() {},
      destroy() {},
    };
  }

  const redemptionMs = options.redemptionMs ?? DEFAULT_REDEMPTION_MS;
  const localOnly = options.localOnly === true;

  let phase = 'idle'; // idle | starting | live | destroyed
  let gen = 0; // bumped by stop()/destroy() so an in-flight start() stands down
  let transcriber = null;
  let stream = null;
  const tracker = createUtteranceTracker();
  let turnActive = false;
  // Set on a genuine VAD speech onset, cleared when a turn finalizes. Gates
  // maybeStartTurn so a late/duplicate transcript callback for the utterance
  // that JUST finalized (Moonshine's inference can trail the VAD's own
  // endpoint) cannot restart a turn on its own trailing edge -- only actual
  // new speech since the last turn ended may open one.
  let speechSeenSinceLastTurn = false;
  let suppressed = false;
  // True only when getUserMedia's track reports echo cancellation actually
  // applied -- the constraint alone is a request, not a contract.
  let ecVerified = false;
  let vadSpeaking = false;
  let endpointTimer = null;
  let micLive = false;

  function publishMicLive(value) {
    const next = value === true;
    if (next === micLive) return;
    micLive = next;
    try {
      cb.onMicLive?.(next);
    } catch {}
  }

  function clearEndpoint() {
    if (endpointTimer !== null) {
      clearTimeout(endpointTimer);
      endpointTimer = null;
    }
  }

  function armEndpoint(ms) {
    clearEndpoint();
    endpointTimer = setTimeout(finalizeTurn, ms);
  }

  function finalizeTurn() {
    clearEndpoint();
    if (!turnActive) return;
    const text = tracker.finalize();
    tracker.reset();
    turnActive = false;
    // Re-armed here, not on the next VAD onset: a trailing commit of this
    // same utterance can land after the grace window (main-thread inference
    // is contended at turn start), and without this it would restart a turn
    // on its own late tail.
    speechSeenSinceLastTurn = false;
    emit('onFinal', text);
  }

  function maybeStartTurn(text, fromCommit) {
    if (phase === 'destroyed') return;
    // Her own leaked speech while she's talking must not read as the user
    // starting a turn -- unless echo cancellation is verified, in which case
    // a real barge-in should interrupt her immediately (setSuppressed below).
    if (suppressed && !ecVerified) return;
    // Only genuine new speech since the last turn ended may open one; see
    // speechSeenSinceLastTurn's declaration.
    if (!speechSeenSinceLastTurn) return;
    turnActive = true;
    tracker.updatePartial(text);
    if (fromCommit) tracker.sealCommit(text);
    const prefix = tracker.commandSoFar();
    emit('onWake', { commandPrefix: prefix });
    if (prefix) emit('onPartial', prefix);
    // A speech onset that already ended (usually the endpoint commit itself
    // landing here): give the speaker one redemption window to continue
    // before the turn finalizes empty; a resumed onSpeechStart cancels it.
    if (!vadSpeaking) armEndpoint(redemptionMs);
  }

  function handlePartial(text) {
    if (!text || !String(text).trim()) return;
    if (!turnActive) {
      maybeStartTurn(text, false);
      return;
    }
    tracker.updatePartial(text);
    emit('onPartial', tracker.commandSoFar());
  }

  function handleCommit(text) {
    if (!text || !String(text).trim()) return;
    if (!turnActive) {
      // A short utterance can commit without a partial ever firing (partials
      // only update every ~16 VAD frames), so commits can start a turn too.
      maybeStartTurn(text, true);
      return;
    }
    tracker.sealCommit(text);
    emit('onPartial', tracker.commandSoFar());
    // The commit the endpoint was waiting on has landed; don't sit out the
    // rest of the grace window.
    if (endpointTimer !== null && !vadSpeaking) finalizeTurn();
  }

  function handleSpeechStart() {
    vadSpeaking = true;
    // Speech resumed inside a grace window: same turn, keep accumulating.
    clearEndpoint();
    // Suppressed-and-unverified means this onset is plausibly her own leaked
    // playback, not the user -- see maybeStartTurn's suppression check. Not
    // marking it fresh here keeps a late transcript callback for it from
    // starting a turn once suppression lifts.
    if (!suppressed || ecVerified) speechSeenSinceLastTurn = true;
    emit('onSpeechStart');
  }

  function handleSpeechEnd() {
    vadSpeaking = false;
    emit('onSpeechEnd');
    if (turnActive) armEndpoint(ENDPOINT_COMMIT_GRACE_MS);
  }

  // Reaches into transcriber.vadModel, which TypeScript calls private but the
  // published bundle leaves unmangled. Guarded: if a future release renames
  // it, the VAD keeps its 768ms default -- a slower endpoint, not a broken ear.
  function tuneRedemption() {
    const frames = Math.max(1, Math.round(redemptionMs / VAD_FRAME_MS));
    try {
      transcriber?.vadModel?.setFrameProcessorOptions?.({ redemptionFrames: frames });
    } catch {}
  }

  function releaseStream() {
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.onended = null;
          track.stop();
        } catch {}
      });
      stream = null;
    }
  }

  async function start() {
    if (phase === 'live') return true;
    if (phase === 'starting') return false;
    if (phase === 'destroyed') {
      emit('onError', 'ear was destroyed');
      return false;
    }
    phase = 'starting';
    const myGen = ++gen;
    const stale = () => myGen !== gen;
    try {
      // Runtime-loaded so the 2MB Moonshine bundle is never evaluated in a
      // native bundle and costs web nothing until the ear actually starts --
      // and because Metro cannot compile the package at all (see
      // moonshineLoader.js).
      const Moonshine = await loadMoonshine();
      if (stale()) return false;

      await pointAtVendoredAssets(Moonshine.Settings, { localOnly });
      if (stale()) return false;

      // All three constraints explicitly true: echo cancellation is what
      // strips Hazlie's own playback out of the mic so a real barge-in still
      // reaches the ear, and browsers merely *usually* default it on --
      // "usually" is not a contract (the Realtime-era hook learned this the
      // hard way; see useRealtimeVoice.js in git history).
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });
      if (stale()) {
        // A newer start()/stop() owns the shared state now; release only what
        // this stale attempt acquired, without touching `stream`.
        acquired.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {}
        });
        return false;
      }
      stream = acquired;
      const track = acquired.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') {
        throw new Error('microphone did not provide a live audio track');
      }
      ecVerified = track?.getSettings?.().echoCancellation === true;
      // Device loss (USB/Bluetooth mic unplugged, OS revoked capture) fires
      // 'ended' on the track. Unhandled, the session stays 'live' but deaf --
      // nothing is heard again with no sign anything broke.
      track.onended = () => {
        if (stale() || !['starting', 'live'].includes(phase)) return;
        // Abort startup too: merely clearing the indicator could leave
        // transcriber.start() pending forever on a dead MediaStream.
        stop();
        emit('onError', 'microphone disconnected');
      };
      // gUM is already holding a live capture track at this point, even though
      // local model/VAD startup is still finishing. The privacy indicator must
      // reflect capture, not pipeline readiness.
      publishMicLive(true);

      // One Transcriber for the ear's lifetime: its model cache and
      // AudioContext survive stop()/start() cycles, only the mic stream is
      // re-acquired. useVAD=false is streaming mode -- rapid speculative
      // partials, with the VAD still gating frames so idle silence costs
      // only the VAD.
      if (!transcriber) {
        transcriber = new Moonshine.Transcriber(
          MOONSHINE_MODEL,
          {
            onModelLoaded: () => {
              tuneRedemption();
              emit('onReady');
            },
            onError: (err) => emit('onError', String(err)),
            onSpeechStart: handleSpeechStart,
            onSpeechEnd: handleSpeechEnd,
            onTranscriptionUpdated: handlePartial,
            onTranscriptionCommitted: handleCommit,
          },
          false
        );
      }
      transcriber.attachStream(stream);
      await transcriber.start();
      if (stale()) return false;
      if (track.readyState !== 'live') {
        throw new Error('microphone disconnected during startup');
      }
      phase = 'live';
      return true;
    } catch (err) {
      // A stale start's late failure must not release a newer start's mic or
      // stomp its phase; stop()/destroy() already cleaned up after this one.
      if (stale()) return false;
      releaseStream();
      publishMicLive(false);
      if (phase !== 'destroyed') phase = 'idle';
      emit('onError', (err && err.message) || String(err));
      return false;
    }
  }

  function stop() {
    gen++;
    clearEndpoint();
    turnActive = false;
    speechSeenSinceLastTurn = false;
    vadSpeaking = false;
    tracker.reset();
    // Capture release is unconditional even if a library teardown regresses.
    // Privacy must not depend on Moonshine's stop() remaining exception-free.
    try {
      transcriber?.stop();
    } catch {}
    // Release the mic so the recording indicator goes dark: a stopped ear
    // that kept the light on would look like it was still listening.
    releaseStream();
    publishMicLive(false);
    if (phase !== 'destroyed') phase = 'idle';
  }

  // The voice layer calls setSuppressed(true) whenever Hazlie is audible.
  // Where the mic track VERIFIED echo cancellation, her playback cannot reach
  // maybeStartTurn's gate, so the suppression request is ignored and a real
  // barge-in can still interrupt her. Where EC is unverified, suppression is
  // real: spec default is suppress-until-verified, because unremoved
  // playback would otherwise start a turn on her own voice. Capture already
  // in flight is unaffected either way.
  function setSuppressed(v) {
    suppressed = !!v;
  }

  function destroy() {
    stop();
    phase = 'destroyed';
    if (transcriber) {
      try {
        transcriber.audioContext?.close();
      } catch {}
      transcriber = null;
    }
  }

  return { start, stop, setSuppressed, destroy };
}

export default createEar;
