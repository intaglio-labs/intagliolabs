// The voice session controller — the framework-free re-expression of what
// useLocalVoice.js did with React (VOICE-PLAN rev 3 §2). Tap-to-arm
// semantics, made stronger than the plan asked: the microphone is only OPEN
// while armed. Arm starts the ear; the first finalized utterance (or
// silence, or a second tap) stops it. No wake word, no fake wake token, no
// action surface — every transcript goes to the same openChatWith path as
// the typed message bar, and the answer comes back here for TTS.
import { createEar } from './lib/ear.js';
import { createVoice } from './lib/voice.js';

const SILENCE_DISARM_MS = 12_000;
const UNPROVISIONED =
  "voice isn't provisioned on this machine yet — run widget/voice/setup-voice.sh";

let ear = null;
let voice = null;
let armed = false;
let silenceTimer = null;

const post = (type, payload) => hzPost(type, payload).catch(() => {});
// The orb wears one of three faces, and a single arm passes through all of
// them: it SPEAKS the greeting, then LISTENS with the mic open, then SPEAKS
// the answer. This used to report one `talking` boolean, set at arm and
// cleared at disarm, so the entire session looked the same — including the
// stretch where the owner is the one talking and Hazlie is only listening.
// `talking` still rides along so an older native that reads only the boolean
// keeps its current behaviour.
const orb = (state) => post('orbState', { state, talking: state !== 'idle' });

function resetSilence() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => disarm(), SILENCE_DISARM_MS);
}

function disarm() {
  armed = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;
  try { ear?.stop(); } catch {}
  orb('idle');
}

// The greeting: "hey" on every arm, spoken BEFORE the microphone opens so
// Moonshine can't transcribe Hazlie's own hello as the owner's utterance.
// A nicety, not a gate — if TTS isn't ready the arm proceeds silently.
async function speakGreeting() {
  try {
    if (!voice) {
      // localOnly, same posture as the ear below: a missing vendored voice
      // model fails closed (silent), never falls back to huggingface.co. The
      // worker's own header says the product sends this; it did not, so a
      // fresh install with no provisioned model phoned home for the voice —
      // an egress path that contradicts the local-only claim. On a
      // provisioned machine the model is present and nothing changes.
      voice = createVoice({}, { localOnly: true });
      await voice.init?.();
    }
    voice.sayText('hey');
    await new Promise((r) => setTimeout(r, 700)); // let the word finish
  } catch {}
}

async function arm() {
  armed = true;
  // The greeting is Hazlie speaking, so the orb genuinely is talking here.
  orb('talking');
  await speakGreeting();
  if (!armed) return; // cancelled during the greeting
  try {
    if (!ear) {
      ear = createEar(
        {
          onFinal(text) {
            const t = String(text ?? '').trim();
            disarm(); // one utterance per arm, exactly
            if (t) post('voiceTranscript', { utterance: t.slice(0, 2000) });
          },
          onError(err) {
            disarm();
            // Missing vendor/model assets surface as WebKit's module/fetch
            // errors; report those as the one fixed provisioning message
            // rather than leaking loader internals into a chat bubble.
            const raw = String(err);
            const provisioning = /module script|Failed to fetch|Load failed|fetch/iu.test(raw);
            post('voiceError', { message: provisioning ? UNPROVISIONED : raw });
          },
          onSpeechStart() { resetSilence(); },
        },
        { localOnly: true } // missing local assets fail closed — no CDN
      );
    }
    await ear.start();
    if (!armed) { try { ear.stop(); } catch {} return; } // cancelled during load
    // Mic is open: from here until a final transcript, the owner is the one
    // talking. This is the state the orb could never show before.
    orb('listening');
    resetSilence();
  } catch (err) {
    disarm();
    post('voiceError', { message: UNPROVISIONED });
  }
}

// Native forwards the orb tap here: arm, or cancel if already armed.
window.__earArm = () => { if (armed) disarm(); else arm(); };

// Native hands the /vault/ask answer text back for speech.
window.__earSpeak = async (text) => {
  const t = String(text ?? '').trim();
  if (!t) return;
  try {
    if (!voice) {
      // localOnly, same posture as the ear below: a missing vendored voice
      // model fails closed (silent), never falls back to huggingface.co. The
      // worker's own header says the product sends this; it did not, so a
      // fresh install with no provisioned model phoned home for the voice —
      // an egress path that contradicts the local-only claim. On a
      // provisioned machine the model is present and nothing changes.
      voice = createVoice({}, { localOnly: true });
      await voice.init?.();
    }
    orb('talking');
    voice.sayText(t);
  } catch {
    post('voiceError', { message: UNPROVISIONED });
  } finally {
    // sayText is fire-and-forget into the worker; the level meter drives the
    // canvas orb in a later phase. For v1 the orb settles once speech is
    // dispatched.
    setTimeout(() => { if (!armed) orb('idle'); }, 400);
  }
};

window.__earStopSpeech = () => { try { voice?.stopAll(); } catch {} orb('idle'); };
