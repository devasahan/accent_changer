/**
 * WAV files from and to Float32Array channels. Pure: used by the spike page
 * (downloads) and the tests (fixtures).
 */

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 16-bit PCM WAV (or 32-bit float with `{ float: true }`) of equal-length channels. */
export function encodeWav(channels, sampleRate, { float = false } = {}) {
  const numCh = channels.length;
  if (!numCh) throw new Error("encodeWav: no channels");
  const frames = channels[0].length;
  if (channels.some((c) => c.length !== frames)) throw new Error("encodeWav: channels differ in length");
  const bytesPerSample = float ? 4 : 2;
  const dataBytes = frames * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buffer);
  writeAscii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(v, 8, "WAVE");
  writeAscii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, float ? 3 : 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  v.setUint16(32, numCh * bytesPerSample, true);
  v.setUint16(34, bytesPerSample * 8, true);
  writeAscii(v, 36, "data");
  v.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const x = channels[c][i];
      if (float) {
        v.setFloat32(offset, Number.isFinite(x) ? x : 0, true);
        offset += 4;
      } else {
        const s = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
        v.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
        offset += 2;
      }
    }
  }
  return new Uint8Array(buffer);
}

/** Channels and sample rate of a PCM (8/16/24/32-bit int) or 32-bit float WAV. */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("decodeWav: not a WAV file");
  let fmt = null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === "data") {
      if (!fmt) throw new Error("decodeWav: data before fmt");
      const bytesPer = fmt.bits / 8;
      const available = Math.min(size, view.byteLength - body);
      const frames = Math.floor(available / (bytesPer * fmt.channels));
      const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          let x;
          if (fmt.format === 3 && fmt.bits === 32) x = view.getFloat32(p, true);
          else if (fmt.format === 1 && fmt.bits === 16) x = view.getInt16(p, true) / 0x8000;
          else if (fmt.format === 1 && fmt.bits === 24) {
            const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
            x = v / 0x800000;
          } else if (fmt.format === 1 && fmt.bits === 32) x = view.getInt32(p, true) / 0x80000000;
          else if (fmt.format === 1 && fmt.bits === 8) x = (view.getUint8(p) - 128) / 128;
          else throw new Error(`decodeWav: unsupported format ${fmt.format}/${fmt.bits}-bit`);
          channels[c][i] = x;
          p += bytesPer;
        }
      }
      return { sampleRate: fmt.sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("decodeWav: no data chunk");
}
