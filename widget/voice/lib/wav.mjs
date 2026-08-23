// Minimal WAV writer for the voice bake. Kokoro hands back raw Float32 mono;
// the browser needs a container decodeAudioData understands, and pulling in an
// encoder dependency for a 44-byte header is not worth the supply chain.
//
// Pure and Node/browser-agnostic on purpose: node:test imports this directly.

/**
 * Encode mono Float32 samples as a 16-bit PCM WAV file.
 *
 * Layout is the canonical 44-byte RIFF header followed by little-endian
 * int16 samples:
 *
 *   0  "RIFF"          8  "WAVE"          22 channels (1)      34 bits (16)
 *   4  36 + dataSize   12 "fmt "          24 sample rate       36 "data"
 *                      16 16 (fmt size)   28 byte rate         40 dataSize
 *                      20 1 (PCM)         32 block align (2)
 *
 * Samples are clamped to [-1, 1] then scaled asymmetrically (32767 up,
 * 32768 down) so both rails are reachable without overflow.
 *
 * @param {Float32Array} float32 mono samples in [-1, 1]
 * @param {number} sampleRate e.g. 24000 for Kokoro
 * @returns {Uint8Array} the complete WAV file
 */
export function encodeWavPcm16(float32, sampleRate) {
  const dataSize = float32.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < float32.length; i++) {
    const v = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return out;
}

export default encodeWavPcm16;
