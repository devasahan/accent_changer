/**
 * Is the converted voice still following the original?
 *
 * The safety mixer's watchdog. The original (mic) is known at once; the
 * converted voice comes back from the cloud D ms later (D about 250-450 ms).
 * Each 10 ms frame of the user's speech is expected in the converted stream
 * around D later; when a run of the user's speech (`missingMs`, counted in
 * speech only: shared pauses never count) found no converted voice where it
 * was due, the converter has stalled and the mixer must fall back to the
 * original, replayed from where the converted voice stopped
 * (`stallStartSample`), so no word is lost. It also flags output that must
 * never reach the meeting: NaN/Inf samples, or a sudden +20 dB burst.
 *
 * Pure (no DOM, no Web Audio, no timers), and it creates no arrays or
 * objects per block (about 2 bytes per block of boxed numbers in Node 22):
 * it runs inside the AudioWorklet and in Node tests. Time is counted in
 * samples pushed. Content time (original) and arrival time (converted) share
 * one clock: frame k of the original was spoken at the moment frame k of the
 * converted arrived.
 *
 * Decision rules, per frame j of the original (spoken at content time j):
 * - It is decided only once the whole span of converted frames where it is
 *   due, [j + D - tol, j + D + tol], has arrived. The span absorbs an error
 *   of up to tolMs in D and short holes in the converted stream (a clock
 *   crossing that drops a block): its loudest frame is what counts.
 * - It is a decided speech frame when the Vad says speech, its level is
 *   within `speechRangeDb` of the user's speech peak, and it stands at least
 *   `modulationDb` above the quietest original frame within ±modulationMs.
 *   Speech rises and falls with its syllables; steady sound the Vad still
 *   takes for speech (a fan that just started, the room after an unmute,
 *   while the Vad's noise floor climbs) never does, and the converter rightly
 *   returns nothing for it. One exception: a steady frame within VOWEL_DB
 *   (6 dB) of the peak counts too once the converter has carried
 *   CARRIED_FRAMES (5) decided frames of the same stretch of speech (since
 *   the Vad's flag last rose). That is the middle of a drawn-out vowel, an
 *   "uhhh", or voiced connected speech whose syllables dip by less than
 *   modulationDb; a fan or a room the converter leaves out never had a
 *   carried frame. (A steady noise that starts while the user talks and
 *   comes within about 6 dB of the voice's peak can still pass for such a
 *   vowel and count as missing.)
 *   Quieter frames (breaths, the Vad's hangover in a pause,
 *   soft syllable edges) carry no evidence: the converter may drop a breath,
 *   and a converted whisper cannot be told from noise. They never start a
 *   miss run or reset one. Only a syllable edge next to a decided frame (down
 *   to `edgeRangeDb`) adds to a run already going, when nothing voice-level
 *   came back for it.
 * - The speech peak (SpeechPeak) the ranges are measured from learns from
 *   modulated speech frames until the converter has carried PEAK_BOOT_FRAMES
 *   (100) frames, and from then on only from the frames it carried: another
 *   voice in the room, a TV or music that the converter leaves out must not
 *   pull the peak down to its own level (every frame of it would then count
 *   as missing). A voice that really got quieter is still followed: after
 *   PEAK_FALLBACK_FRAMES (200) speech frames without a carried one, a
 *   modulated frame under the judging range that the converted stream
 *   carried at the frame's own level teaches the peak too. A cough, a click
 *   or one loud word cannot lift the peak far above the voice: it stays
 *   within peakCapDb of the level the loudest fifth of the last `peakSpanMs`
 *   (5 s) of that speech reaches, so even a coughing fit or a long laugh is
 *   too short a part of the span to set it.
 * - It is matched when the loudest converted frame of its span is at least
 *   orig + offsetDb - dropDb AND voice-level: within `voiceRangeDb` of the
 *   converted speech peak (the user's speech peak + offsetDb) AND, when the
 *   original dipped by modulationDb within modulationMs before the frame,
 *   the converted stream dips too: somewhere within ±coverLagMs of where
 *   that dip was due it is at least DIP_DB (6 dB) under the span's loudest
 *   frame. The level tests keep the noise that a stalled stream decays into
 *   (packet-loss concealment, comfort noise at -50 dBFS) from passing for
 *   speech while it is far under the voice; the dip test catches it when it
 *   comes close to the voice's level (a quiet mic, a quiet converter), and
 *   a stuck converter that loops a piece of the voice at full level. The
 *   dip is looked for only backwards: where a later dip is due, the
 *   converted frames have not all arrived yet.
 * - When a run of misses starts, the ±tol span and a fading concealment
 *   tail have usually "matched" the first frames after the real stop. So the
 *   detector looks back for the last converted frames that really carried
 *   the voice (two in a row, each within `aliveDb` of its own loud original
 *   frame) and counts the matched speech after them as missing too (at most
 *   tolMs + concealMs of it, so one false miss in healthy speech stays far
 *   from a stall). That point, in content time, is `stallStartSample`; it
 *   errs early, so a replay repeats a little rather than losing a word.
 *   Converted and original frames are paired at the lag the stream really
 *   followed while it was whole (the coverage's steady lag, see below),
 *   which may differ from D by tens of ms (a jitter buffer that just grew
 *   or shrank; a lag within a frame of D counts as D); a later lag moves
 *   the start earlier by that much, an earlier one never moves it later. When nothing within `lookBackMs`
 *   carried the voice (the converter stopped in a sentence's soft ending
 *   and the miss run began only in the next sentence, after a pause), the
 *   look-back walks on across the pause, up to FAR_BACK_MS (1.2 s), to the
 *   previous sentence's last loud frame: if the converted voice did not
 *   carry it, the voice stopped in that sentence, and the start is its last
 *   pair of alive frames; if it did, the start stays at the far end of
 *   lookBackMs, so a stall that began in the pause repeats nothing. Behind
 *   a concealment tail that kept the voice's level and shape for a few
 *   frames the start is that much late (the mixer replays from tolMs
 *   earlier still); when such a tail carried the last loud frame before a
 *   pause, a stop in the soft ending after it is still placed in the pause,
 *   and the rest of that ending (up to about 60 ms of sound) is not replayed.
 * - A stream that keeps losing pieces (sustained underruns, every other
 *   block missing) still has a voice-level frame in nearly every ±tol span.
 *   So for each matched frame the detector also looks at the converted audio
 *   exactly where the frame is due, at each lag within ±coverLagMs (wider
 *   than the span: a jitter buffer that grew by 100 ms is still found; this
 *   look waits until those frames have arrived): a hole is digital silence
 *   the original does not have, or (as LEVEL_HOLE, 2/3 of one) a level far
 *   under the expected one: a converter band-limited to 3-4 kHz takes the
 *   fricatives that far down, and that alone must not make a healthy stream
 *   choppy. When, over the last `choppyMs` of decided speech, even the
 *   best-fitting lag finds holes in more than `choppyShare` (20 %) of it,
 *   the stream is choppy: its matched frames earn no health and reset
 *   nothing, and the share of each frame that is missing counts toward a
 *   stall. The run starts at the first hole after the stream was last whole
 *   (WHOLE_MS, 400 ms, of matched speech in a row without a hole at the lag
 *   it followed), at most lookBackMs before the newest cluster of holes and
 *   as far back as the history reaches, so the garbled words before the
 *   stream counted as choppy are replayed too (in the mixer, as far back as
 *   its replay history reaches). Isolated holes (a block lost now and then)
 *   stay far under that share; a healthy stream whose delay drifts by
 *   ±40 ms (a jitter buffer adapting) comes close to it, and may be counted
 *   as choppy for a few hundred ms.
 */

import { SILENCE_DB, SpeechPeak, frameDb } from "./vad.js";

const UNDECIDED = 0;
const MATCHED = 1;
const MISSING = 2;
const HELD = 3; // matched by its span while the stream is choppy: no health, no reset

/** Level tolerance of the +jumpDb test: frame levels jitter by a fraction of a dB, a +20 dB copy must count as +20. */
const JUMP_SLACK_DB = 1;

/** Before the user has spoken, converted output louder than this + jumpDb is a jump. */
const JUMP_QUIET_DB = -50;

/**
 * Under every frame level (frames are at least SILENCE_DB): where a search for the loudest
 * frame starts. Not a whole number on purpose: a loop whose running maximum starts at an
 * integer constant is kept boxed by V8 and allocates for every new maximum.
 */
const BELOW_ALL_DB = SILENCE_DB - 0.5;

/** Over every frame level (even a frame of huge finite samples): where a search for the quietest frame starts. Not whole, as above. */
const ABOVE_ALL_DB = 1000.5;

/** Largest per-frame step of the offset estimate (dB): one odd frame cannot drag it. */
const OFFSET_STEP_DB = 6;

/** A sample this close to zero is digital silence (an underrun, a lost block), not a voice crossing zero. */
const DROPOUT_LEVEL = 1e-6;

/** Digital silence this long (ms) inside a frame is a dropout: a voice never stays at zero for 0.6 ms. */
const DROPOUT_MS = 0.6;

/** Coverage: a frame missing less than this share has no hole worth the name (a few samples). */
const HOLE_MIN = 0.05;

/**
 * Coverage: a frame whose level is far under the expected one, but with no digital silence in it,
 * is this much of a hole. A converter band-limited to 3-4 kHz takes a fricative ("s", "f") 20 dB
 * or more under the original's: that is not a lost block, and with a whole hole per such frame a
 * healthy band-limited stream would hover around choppyShare. At 2/3, level holes alone make a
 * stream choppy only above 1.5 x choppyShare (30 %), lost blocks at choppyShare (20 %).
 */
const LEVEL_HOLE = 2 / 3;

/** Coverage: this many clean decided frames in a row separate one cluster of holes from the next. */
const CLUSTER_GAP = 8;

/** Coverage: a choppy stream is whole again only when its hole share falls under this part of choppyShare (no flicker). */
const CHOPPY_EXIT = 2 / 3;

/** Coverage: the lag a whole stream follows is averaged over about this many matched frames. */
const STEADY_FRAMES = 100;

/** Sound within this of the speech peak is something a listener would miss (the Vad's own speech range). */
const SOUND_RANGE_DB = 25;

/** Coverage: this much matched speech in a row without a hole (at the lag the stream followed) and the stream counts as whole (ms). */
const WHOLE_MS = 400;

/** A steady frame within this of the speech peak is a vowel, not steady noise, inside speech the converter carries (dB). */
const VOWEL_DB = 6;

/** ... once the converter has carried this many decided frames since the Vad's flag last rose. */
const CARRIED_FRAMES = 5;

/** The speech peak learns from all modulated speech until the converter has carried this many frames ... */
const PEAK_BOOT_FRAMES = 100;

/** ... and after that from carried frames only, or, after this many speech frames without one, from quieter frames it carried at their own level. */
const PEAK_FALLBACK_FRAMES = 200;

/** A converted voice dips by at least this (dB) where the original dipped by modulationDb. */
const DIP_DB = 6;

/** When nothing within lookBackMs carried the voice, the stall-start look-back walks on across a pause this far (ms). */
const FAR_BACK_MS = 1200;

export class StallDetector {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate=48000]
   * @param {number} [options.frameMs=10] frame length
   * @param {number} [options.tolMs=40] each original frame is looked for this far either side of D
   * @param {number} [options.missingMs=350] missing original speech that makes a stall
   * @param {number} [options.dropDb=18] converted may be this much quieter than expected and still match
   * @param {number} [options.historyMs=2500] frame history kept; a D longer than about historyMs - lookBackMs - 3 tolMs counts as unknown
   * @param {number} [options.jumpDb=20] a burst this far above the expected level ...
   * @param {number} [options.jumpMs=20] ... for this long is bad output
   * @param {number} [options.speechRangeDb=14] decided speech frames are within this of the speech peak
   * @param {number} [options.edgeRangeDb=20] quieter frames next to them, down to this, count as speech in a miss run
   * @param {number} [options.voiceRangeDb=20] converted audio within this of the converted speech peak (the user's peak + offsetDb) is voice.
   *   Until the offset is learned it is 0, so a converted voice more than about this much under the mic counts as missing: the mixer stays on the user's voice
   * @param {number} [options.modulationDb=10] decided speech frames stand this far above the quietest original frame ...
   * @param {number} [options.modulationMs=250] ... within this either side (steady sound is never speech evidence)
   * @param {number} [options.aliveDb=6] stall-start look-back: a converted frame within this of its own expected level still carried the voice
   * @param {number} [options.lookBackMs=500] the look-back searches this far back (pauses included); across a pause to the
   *   sentence before, up to 1.2 s (see the file header)
   * @param {number} [options.concealMs=100] at most tolMs + this of earlier matched speech is turned into missing speech
   * @param {number} [options.healthResetMs=30] a miss run this long resets healthyMs
   * @param {number} [options.offsetTauMs=2000] time constant of the level-offset estimate, in matched speech
   * @param {number} [options.maxOffsetDb=12] the offset estimate is clamped to ±this
   * @param {number} [options.peakHoldMs=2000] the speech peak holds this long (in decided speech time) ...
   * @param {number} [options.peakDecayDbPerSec=3] ... then sinks this fast
   * @param {number} [options.peakSpanMs=5000] ... and stays within peakCapDb of the level the loudest fifth of this much speech reaches
   *   (twice the Vad's span: a coughing fit or a long laugh must not fill a fifth of it)
   * @param {number} [options.peakCapDb=4]
   * @param {number} [options.choppyMs=400] the coverage check looks at this much recent decided speech ...
   * @param {number} [options.choppyShare=0.2] ... and calls the stream choppy when more than this share of it has holes
   *   (a healthy stream reaches about 0.11, 0.2 while its delay drifts by ±40 ms; a stream losing one block in four, 0.25) ...
   * @param {number} [options.coverLagMs=150] ... at the best lag within ±this of D
   * @param {number} [options.quietRefDb=10] jump test: the reference level never goes below the converted speech peak minus this
   * @param {number} [options.maxDelayMs=1000] jump test with D unknown: the original's loudest frame in this span is the reference
   */
  constructor({
    sampleRate = 48000,
    frameMs = 10,
    tolMs = 40,
    missingMs = 350,
    dropDb = 18,
    historyMs = 2500,
    jumpDb = 20,
    jumpMs = 20,
    speechRangeDb = 14,
    edgeRangeDb = 20,
    voiceRangeDb = 20,
    modulationDb = 10,
    modulationMs = 250,
    aliveDb = 6,
    lookBackMs = 500,
    concealMs = 100,
    healthResetMs = 30,
    offsetTauMs = 2000,
    maxOffsetDb = 12,
    peakHoldMs = 2000,
    peakDecayDbPerSec = 3,
    peakSpanMs = 5000,
    peakCapDb = 4,
    choppyMs = 400,
    choppyShare = 0.2,
    coverLagMs = 150,
    quietRefDb = 10,
    maxDelayMs = 1000,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    this.frameMs = (this.frameLen * 1000) / sampleRate;
    const frames = (ms) => Math.max(0, Math.round(ms / this.frameMs));
    this.tol = frames(tolMs);
    this.missingFrames = Math.max(1, Math.ceil(missingMs / this.frameMs - 1e-9));
    this.dropDb = dropDb;
    this.jumpDb = jumpDb;
    this.jumpFrames = Math.max(1, Math.ceil(jumpMs / this.frameMs - 1e-9));
    this.speechRangeDb = speechRangeDb;
    this.edgeRangeDb = edgeRangeDb;
    this.voiceRangeDb = voiceRangeDb;
    this.modulationDb = modulationDb;
    this.modFrames = frames(modulationMs);
    this.aliveDb = aliveDb;
    this.backFrames = Math.max(this.tol + 1, frames(lookBackMs));
    this.farBackFrames = Math.max(this.backFrames, frames(FAR_BACK_MS));
    this.wholeFrames = Math.max(1, frames(WHOLE_MS));
    this.recreditMax = this.tol + frames(concealMs);
    this.healthResetFrames = Math.max(1, Math.ceil(healthResetMs / this.frameMs - 1e-9));
    this.offsetAlpha = Math.min(1, this.frameMs / Math.max(this.frameMs, offsetTauMs));
    this.maxOffsetDb = maxOffsetDb;
    this.quietRefDb = quietRefDb;
    this.searchFrames = frames(maxDelayMs);
    this.choppyShare = choppyShare;
    this.coverLag = Math.max(this.tol, frames(coverLagMs));
    this._dropRun = Math.max(2, Math.round((DROPOUT_MS * sampleRate) / 1000));

    this.cap = Math.max(frames(historyMs), 4 * this.tol + this.backFrames + 8, 2 * this.modFrames + 2, 4 * this.coverLag + 8);
    this._orig = new Float32Array(this.cap); // original level by content frame
    this._conv = new Float32Array(this.cap); // converted level by arrival frame
    this._odrop = new Float32Array(this.cap); // share of the original frame that is a dropout (digital silence)
    this._cdrop = new Float32Array(this.cap); // the same for the converted frame
    this._speech = new Uint8Array(this.cap); // the Vad's speech flag by content frame
    this._state = new Uint8Array(this.cap); // decision by content frame
    this._sp = new SpeechPeak({
      frameMs: this.frameMs,
      holdMs: peakHoldMs,
      decayDbPerSec: peakDecayDbPerSec,
      spanMs: peakSpanMs,
      capDb: peakCapDb,
    });

    // Coverage of the last `choppyMs` of matched speech: for each frame, the hole share of the
    // converted audio exactly where it was due, at each lag (-coverLag..+coverLag).
    this._lags = 2 * this.coverLag + 1;
    this._covLen = Math.max(4, frames(choppyMs));
    this._covW = new Float32Array(this._covLen * this._lags);
    this._covJ = new Float64Array(this._covLen); // content frame of each entry
    this._covMiss = new Uint8Array(this._covLen); // 1: an entry its span missed (no weights; a hole for _choppyRun)
    this._covSum = new Float64Array(this._lags);
    this._steady = new Float64Array(this._lags); // slow average of each lag's holes while the stream is whole

    this._origSum = 0;
    this._convSum = 0;
    this._frameO = 0.5; // a complete frame's sums, for _frame (doubles from the start)
    this._frameC = 0.5;
    this._speechCount = 0;
    this._fill = 0;
    this._oZeros = 0; // current digital-silence runs (samples) ...
    this._cZeros = 0;
    this._oDropped = 0; // ... and dropout samples in the frame being filled
    this._cDropped = 0;
    this._frames = 0; // complete frames
    this._next = 0; // next content frame to decide
    this._covNext = 0; // next decided frame to check the coverage of
    this._d = -1; // D in frames the decisions use (-1: unknown)
    this._ds = 0; // D in samples
    this._offset = 0;
    this._learned = 0; // matched frames the offset has learned from
    this._uttMatched = 0; // matched frames since the Vad's speech flag last rose (for steady vowels)
    this._unmatched = 0; // speech frames (the Vad's flag) decided since the last matched one (for the peak's fallback)
    this._clearCoverage();
    this.reset();
  }

  /** Clear the stall and bad-output flags and the counters. The learned offset, the speech peak and the history stay. */
  reset() {
    this._stalled = false;
    this._stallStart = 0;
    this._bad = false;
    this._jumpRun = 0;
    this._missRun = 0;
    this._runStart = 0;
    this._healthy = 0;
    this._following = false;
  }

  /**
   * One block. `orig`: the mic (content time = now); `conv`: the converted
   * voice (arrival time = now); same length. `delayMs`: the current D, null
   * when unknown. `speech`: the Vad's state for the original (one boolean
   * per block).
   */
  push(orig, conv, delayMs, speech) {
    const len = this.frameLen;
    const run = this._dropRun;
    const n = Math.min(orig.length, conv.length);
    let os = this._origSum;
    let cs = this._convSum;
    let sp = this._speechCount;
    let fill = this._fill;
    let oz = this._oZeros;
    let cz = this._cZeros;
    let od = this._oDropped;
    let cd = this._cDropped;
    for (let i = 0; i < n; i++) {
      const o = orig[i];
      const c = conv[i];
      os += o * o;
      if (c - c === 0) cs += c * c;
      else this._bad = true; // NaN or ±Infinity: never let it near the meeting
      if (speech) sp++;
      // Digital silence runs: a run counts as a dropout once it is `run` samples long.
      if (o <= DROPOUT_LEVEL && o >= -DROPOUT_LEVEL) {
        if (++oz >= run) od += oz === run ? run : 1;
      } else oz = 0;
      if (c <= DROPOUT_LEVEL && c >= -DROPOUT_LEVEL) {
        if (++cz >= run) cd += cz === run ? run : 1;
      } else cz = 0;
      if (++fill === len) {
        // The frame's sums go through fields: a double passed to a call is boxed (a heap
        // allocation) unless the engine inlines the callee.
        this._frameO = os;
        this._frameC = cs;
        this._frame(sp, od, cd, delayMs);
        os = 0;
        cs = 0;
        sp = 0;
        od = 0;
        cd = 0;
        fill = 0;
      }
    }
    this._origSum = os;
    this._convSum = cs;
    this._speechCount = sp;
    this._fill = fill;
    this._oZeros = oz;
    this._cZeros = cz;
    this._oDropped = od;
    this._cDropped = cd;
  }

  _frame(speechCount, origDropped, convDropped, delayMs) {
    const origSum = this._frameO;
    const convSum = this._frameC;
    const k = this._frames++;
    const slot = k % this.cap;
    const len = this.frameLen;
    const o = frameDb(origSum < Infinity ? origSum : 0, len);
    this._orig[slot] = o;
    this._conv[slot] = frameDb(convSum < Infinity ? convSum : 0, len);
    // A run that started in the frame before is counted here: the share can pass 1.
    this._odrop[slot] = origDropped < len ? origDropped / len : 1;
    this._cdrop[slot] = convDropped < len ? convDropped / len : 1;
    this._speech[slot] = speechCount * 2 >= len ? 1 : 0;
    this._state[slot] = UNDECIDED;
    // Until the converter has carried some speech, the speech peak learns from frame k - modFrames,
    // now that the frames after it are here to tell whether it is speech evidence (modulated) or
    // steady sound. After that only from the frames the converter carried (_matched), see the header.
    const jm = k - this.modFrames;
    if (this._learned < PEAK_BOOT_FRAMES && jm >= 0 && this._speech[jm % this.cap] && this._modulated(jm)) {
      this._sp.push(this._orig[jm % this.cap], true);
    }

    const d = this._delayFrames(delayMs);
    if (d !== this._d) {
      this._d = d;
      this._clearCoverage(); // the lags it measured were relative to the old D
    }
    this._checkJump(k, d);
    if (d < 0) {
      // Not converting: nothing is due, and when D becomes known the frames from before are not judged.
      this._next = k + 1;
      this._covNext = k + 1;
      return;
    }
    const oldest = k - this.cap + 2 * this.tol + this.backFrames + 2; // everything a decision reads is still in the history
    if (this._next < oldest) this._next = oldest;
    while (this._next + d + this.tol <= k) this._decide(this._next++, d);
    if (this._covNext < oldest) this._covNext = oldest;
    while (this._covNext < this._next && this._covNext + d + this.coverLag <= k) this._coverage(this._covNext++, d);
  }

  /** D in frames, or -1 when unknown or too long for the history. */
  _delayFrames(delayMs) {
    if (delayMs == null || !Number.isFinite(delayMs)) return -1;
    const d = Math.max(0, Math.round(delayMs / this.frameMs));
    if (d + Math.max(3 * this.tol + this.backFrames, 2 * this.coverLag) + 4 >= this.cap) return -1;
    this._ds = Math.max(0, Math.round((delayMs * this.sampleRate) / 1000));
    return d;
  }

  /**
   * Is original frame j at least modulationDb above the quietest original
   * frame within ±modFrames (as far as they have arrived)? Speech dips
   * between syllables; steady noise does not.
   */
  _modulated(j) {
    const cap = this.cap;
    const o = this._orig[j % cap];
    const floor = o - this.modulationDb;
    const last = Math.min(this._frames - 1, j + this.modFrames);
    for (let i = Math.max(0, j - this.modFrames, this._frames - cap); i <= last; i++) {
      if (this._orig[i % cap] <= floor) return true;
    }
    return false;
  }

  _decide(j, d) {
    const cap = this.cap;
    const slot = j % cap;
    if (!this._speech[slot]) {
      this._uttMatched = 0; // a pause: neither counts nor resets, and the speech after it starts afresh
      return;
    }
    const o = this._orig[slot];
    const peak = this._sp.db;
    if (!(peak > SILENCE_DB)) return;
    const loud = peak - this.speechRangeDb;
    if (
      ++this._unmatched > PEAK_FALLBACK_FRAMES &&
      o < loud &&
      this._learned > PEAK_BOOT_FRAMES &&
      this._modulated(j) &&
      this._dueMax(j, d) >= o + this._offset - this.dropDb
    ) {
      // Speech under the judging range that the converted stream carried at its own level: the
      // user's voice got quieter (the peak must follow it), not a sound the converter leaves out.
      this._sp.push(o, true);
    }
    if (o < peak - this.edgeRangeDb) return;
    // Steady sound is no evidence either way, unless it is at vowel level inside a stretch of
    // speech the converter has been carrying (a drawn-out vowel; see the file header).
    if (!this._modulated(j) && !(o >= peak - VOWEL_DB && this._uttMatched >= CARRIED_FRAMES)) return;
    if (o < loud) {
      // Too quiet to show that the converted voice is there. But the edge of a syllable is
      // speech time all the same: while a miss run is going and nothing voice-level came
      // back around it, it adds to the run (it never starts one, so a breath the converter
      // leaves out cannot make a stall).
      if (
        this._missRun > 0 &&
        ((j > 0 && this._orig[(j - 1) % cap] >= loud) || (j + 1 < this._frames && this._orig[(j + 1) % cap] >= loud)) &&
        this._dueMax(j, d) < peak + this._offset - this.voiceRangeDb
      ) {
        this._state[slot] = MISSING;
        this._addMiss(1);
      }
      return;
    }
    const cmax = this._dueMax(j, d);
    const expected = o + this._offset - this.dropDb;
    if (cmax >= expected && cmax >= peak + this._offset - this.voiceRangeDb && this._convDips(j, d, cmax)) {
      if (this._choppy) {
        // The span found voice, but the stream keeps losing pieces: no health and no reset,
        // and the share it has been losing lately counts as missing.
        this._state[slot] = HELD;
        this._following = false;
        if (this._missRun === 0) this._runStart = j * this.frameLen; // picked up again after reset()
        this._addMiss(this._chopShare);
      } else {
        this._state[slot] = MATCHED;
        this._uttMatched++;
        this._matched(j, cmax);
      }
    } else {
      this._state[slot] = MISSING;
      this._missing(j, d);
    }
  }

  /**
   * Does the converted stream dip where the original last dipped? The newest
   * original frame at least modulationDb under frame j within modulationMs
   * before it is looked for in the converted stream within ±coverLag of
   * where it was due (D may be stale): some converted frame there must be at
   * least DIP_DB under `cmax`, the loudest frame of j's span. Steady
   * concealment or comfort noise, and a converter looping a piece of the
   * voice, do not dip; a converted voice does. With no dip of the original
   * in reach (a drawn-out vowel) there is nothing to test. Only backwards:
   * where a later dip is due, the converted frames have not arrived yet.
   */
  _convDips(j, d, cmax) {
    const cap = this.cap;
    const floor = this._orig[j % cap] - this.modulationDb;
    let q = -1;
    for (let i = j, lo = Math.max(0, j - this.modFrames, this._frames - cap); i >= lo; i--) {
      if (this._orig[i % cap] <= floor) {
        q = i;
        break;
      }
    }
    if (q < 0) return true;
    let cmin = ABOVE_ALL_DB;
    for (let k = Math.max(0, q + d - this.coverLag), end = Math.min(q + d + this.coverLag, this._frames - 1); k <= end; k++) {
      const c = this._conv[k % cap];
      if (c < cmin) cmin = c;
    }
    return cmax - cmin >= DIP_DB;
  }

  /** Loudest converted frame of the span where original frame j is due. */
  _dueMax(j, d) {
    let cmax = BELOW_ALL_DB;
    for (let k = Math.max(0, j + d - this.tol), end = j + d + this.tol; k <= end; k++) {
      const c = this._conv[k % this.cap];
      if (c > cmax) cmax = c;
    }
    return cmax;
  }

  /**
   * Coverage of decided frame j, once the converted frames up to coverLag
   * after where it is due have arrived. For a frame its span matched:
   * records the hole share of the converted frame exactly where j is due,
   * at each lag within ±coverLag (digital silence the original frame does
   * not have, or the whole frame when its level is under what a match
   * needs). A frame its span missed takes a slot as a hole, but no part in
   * the share: misses are the miss run's business (a stall is not "choppy",
   * and with a stale D the voice is still there at another lag). The stream
   * is choppy while even the best-fitting lag finds holes in more than
   * choppyShare of the matched frames among the entries; entering that
   * state moves the miss run back to where the holes began.
   */
  _coverage(j, d) {
    const cap = this.cap;
    const state = this._state[j % cap];
    if (state === UNDECIDED) return;
    const lags = this._lags;
    const len = this._covLen;
    const w = this._covW;
    const sum = this._covSum;
    const e = this._covAt;
    const base = e * lags;
    if (this._covN === len) {
      // The oldest entry leaves.
      if (!this._covMiss[e]) {
        for (let l = 0; l < lags; l++) sum[l] -= w[base + l];
        this._covM--;
      }
    } else this._covN++;
    const miss = state === MISSING;
    this._covMiss[e] = miss ? 1 : 0;
    this._covJ[e] = j;
    this._covAt = e + 1 === len ? 0 : e + 1;
    if (!miss) {
      const own = this._odrop[j % cap];
      const expected = this._orig[j % cap] + this._offset - this.dropDb;
      const steady = this._steady;
      const a = this._choppy ? 0 : 1 / STEADY_FRAMES;
      for (let l = 0, k = j + d - this.coverLag; l < lags; l++, k++) {
        let h = 1; // before the stream began: nothing there
        if (k >= 0) {
          const s = k % cap;
          h = this._cdrop[s] - own; // digital silence the original does not have
          if (this._conv[s] < expected && h < LEVEL_HOLE) h = LEVEL_HOLE;
          if (h < 0) h = 0;
        }
        w[base + l] = h;
        sum[l] += w[base + l]; // the stored (float) value, so that taking it out again is exact
        steady[l] += a * (h - steady[l]);
      }
      this._covM++;
    }
    // Where losses began, for _choppyRun: the first hole after the stream was last whole
    // (wholeFrames of matched speech in a row without a hole at the lag it followed). Frames
    // the span missed are left out, as in the share: a stall's misses are the miss run's
    // business, and an odd false miss in healthy speech must not mark where losses began.
    if (!miss) {
      if (w[base + this._bestLag(this._steady)] > HOLE_MIN) {
        if (this._wholeRun >= this.wholeFrames) this._firstHole = j;
        this._wholeRun = 0;
      } else this._wholeRun++;
    }
    const best = this._bestLag(sum);
    const m = this._covM;
    const was = this._choppy;
    const limit = (was ? CHOPPY_EXIT * this.choppyShare : this.choppyShare) * m;
    // A few frames are no evidence yet: a quarter of the entries matched at least.
    this._choppy = m * 4 >= len && sum[best] > limit;
    this._chopShare = m > 0 ? sum[best] / m : 0;
    if (this._choppy && !was) this._choppyRun();
  }

  /** Index of the smallest of the per-lag `costs`; of equal ones, the lag closest to D. */
  _bestLag(costs) {
    const mid = this.coverLag;
    let best = mid;
    for (let o = 1; o <= mid; o++) {
      if (costs[mid - o] < costs[best]) best = mid - o;
      if (costs[mid + o] < costs[best]) best = mid + o;
    }
    return best;
  }

  /**
   * The stream just turned choppy. Its matched frames were missing pieces
   * all along: the miss run goes back to the first hole after the stream was
   * last whole (see _coverage), at most lookBackMs before the first hole of
   * the newest cluster of holes (no CLUSTER_GAP clean frames in between),
   * and never past the history; the count is the missing share of the
   * cluster's frames. (A stream that is never whole for WHOLE_MS, say a
   * band-limited one whose fricatives count as holes, keeps an old first
   * hole: unbounded, a stall or a main-thread fault in its choppy moments
   * would replay seconds of speech.) A loss pattern that hovers around choppyShare turns
   * choppy only now and then, seconds after the losses began, and every
   * pause ends a cluster: the newest cluster alone would put the start that
   * late. The holes are read at the lag the stream followed while it was
   * whole: near the start of the losses the coverage's own best lag is a
   * poor guide (a lag that maps the first lost frames onto audio from before
   * the loss "fits" better, and would put the start late). A run already
   * going keeps the earlier start and the larger count.
   */
  _choppyRun() {
    const lag = this._bestLag(this._steady);
    let first = this._cluster(lag);
    if (first === Infinity) return;
    if (this._firstHole >= 0 && this._firstHole < first) {
      first = Math.max(this._firstHole, first - this.backFrames, this._frames - this.cap + 1 + this.coverLag);
    }
    const start = this._holeStart(first, lag) * this.frameLen; // the start of that frame
    if (this._missRun === 0 || start < this._runStart) this._runStart = start;
    if (this._clusterHoles > this._missRun) this._missRun = this._clusterHoles;
    this._healthy = 0;
    this._following = false;
    this._addMiss(0);
  }

  /**
   * The first hole the coverage saw is in a decided frame; the losses may have
   * begun a little earlier, in sound no decision looks at (a syllable's soft
   * tail, a consonant). Walks back from content frame j0 over the frames
   * that carry sound the converted voice should carry (speech, within
   * SOUND_RANGE_DB of the peak) and returns the oldest one whose converted
   * frame at lag index `lag` has a hole, stopping at CLUSTER_GAP whole ones
   * in a row.
   */
  _holeStart(j0, lag) {
    const cap = this.cap;
    const shift = this._d + lag - this.coverLag;
    const quiet = this._sp.db - SOUND_RANGE_DB;
    const lo = Math.max(0, j0 - this.backFrames, this._frames - cap + 1 + this.coverLag);
    let first = j0;
    let clean = 0;
    for (let j = j0 - 1; j >= lo; j--) {
      const s = j % cap;
      const o = this._orig[s];
      if (!this._speech[s] || o < quiet) continue; // nothing there to lose
      const k = j + shift;
      if (k < 0) break;
      const c = k % cap;
      if (this._conv[c] < o + this._offset - this.dropDb || this._cdrop[c] - this._odrop[s] > HOLE_MIN) {
        first = j;
        clean = 0;
      } else if (++clean >= CLUSTER_GAP) break;
    }
    return first;
  }

  /**
   * The content frame of the first hole of the newest cluster of holes at
   * lag index `lag` (Infinity if none), and in _clusterHoles the missing
   * share of the cluster's frames.
   */
  _cluster(lag) {
    const lags = this._lags;
    const len = this._covLen;
    const w = this._covW;
    let holes = 0;
    let first = Infinity;
    let clean = 0;
    this._clusterHoles = 0;
    for (let t = 0, e = this._covAt; t < this._covN; t++) {
      e = e === 0 ? len - 1 : e - 1; // newest to oldest
      const h = this._covMiss[e] ? 1 : w[e * lags + lag];
      holes += h;
      if (h > HOLE_MIN) {
        first = this._covJ[e];
        this._clusterHoles = holes;
        clean = 0;
      } else if (first !== Infinity && ++clean >= CLUSTER_GAP) break;
    }
    return first;
  }

  _clearCoverage() {
    this._covW.fill(0);
    this._covSum.fill(0);
    this._steady.fill(0);
    this._covN = 0; // entries in the coverage (the last choppyMs of decided speech)
    this._covM = 0; // ... of them matched by their span
    this._covAt = 0;
    this._choppy = false;
    this._chopShare = 0; // the coverage's hole share at the best lag
    this._clusterHoles = 0;
    this._wholeRun = this.wholeFrames; // matched frames in a row without a hole (counted as whole to begin with)
    this._firstHole = -1; // content frame of the first hole after the stream was last whole (-1: none)
  }

  _matched(j, cmax) {
    // Level offset: the loudest converted frame of the span against the loudest original frame around j.
    let omax = BELOW_ALL_DB;
    for (let i = Math.max(0, j - this.tol), end = j + this.tol; i <= end; i++) {
      const v = this._orig[i % this.cap];
      if (v > omax) omax = v;
    }
    // EMA with a running-mean start, so the first second of speech already gives a usable offset.
    const alpha = Math.max(this.offsetAlpha, 1 / ++this._learned);
    const step = Math.max(-OFFSET_STEP_DB, Math.min(OFFSET_STEP_DB, cmax - omax - this._offset));
    const next = this._offset + alpha * step;
    this._offset = Math.max(-this.maxOffsetDb, Math.min(this.maxOffsetDb, next));
    // After the bootstrap the speech peak learns from what the converter carried (see the header).
    if (this._learned > PEAK_BOOT_FRAMES) this._sp.push(this._orig[j % this.cap], true);
    this._unmatched = 0;
    this._healthy++;
    this._following = true;
    this._missRun = 0;
  }

  _missing(j0, d) {
    this._following = false;
    if (this._missRun === 0) {
      // A new run. Its first frames may have been matched by the span reaching back to
      // before the stop, or by a concealment tail: find where the voice really stopped.
      // At most recreditMax of them are taken back, the latest first, so that a single
      // false miss in healthy speech can never come near a stall.
      // Frames are paired at the lag the stream really followed while it was whole (D may be
      // stale by tens of ms). A later lag moves the start earlier by that much; an earlier one
      // leaves it where D puts it, so it never errs late. A lag one frame from D is D: a
      // band-limited converter makes the average settle a frame off when D is right, and
      // pairing at it finds fewer alive frames (longer false miss runs that reset the health).
      let off = this._bestLag(this._steady) - this.coverLag;
      if (off < 2 && off > -2) off = 0;
      const k = this._lastAlive(j0, d, d + off);
      const len = this.frameLen;
      const ds = this._ds + (off > 0 ? off : 0) * len;
      this._runStart = Math.max(0, k * len - ds); // the start of that frame: errs early
      let run = 1;
      // Speech after that frame (it carried the voice, at least in part) was missing.
      const from = Math.max(Math.ceil(((k + 1) * len - ds) / len), j0 - this.backFrames, 0);
      for (let j = j0 - 1, left = this.recreditMax; j >= from && left > 0; j--) {
        const slot = j % this.cap;
        if (this._state[slot] === MATCHED) {
          this._state[slot] = MISSING;
          run++;
          left--;
          if (this._healthy > 0) this._healthy--;
        }
      }
      this._missRun = run - 1;
    }
    this._addMiss(1);
  }

  /** Add `frames` (a whole frame, or the missing share of one) to the miss run. */
  _addMiss(frames) {
    this._missRun += frames;
    if (this._missRun >= this.healthResetFrames) this._healthy = 0;
    if (!this._stalled && this._missRun >= this.missingFrames) {
      this._stalled = true;
      this._stallStart = this._runStart;
    }
  }

  /**
   * The last converted frame (arrival index) that still carried the voice
   * before the span of j0, the first missing frame of a run: where the
   * converted voice stopped. Converted frame k is paired with original frame
   * k - da (da: the lag the stream followed; d: the D in use). Searched back
   * up to lookBackMs, pauses included. When nothing in reach carried it, the
   * search walks on across non-speech (a pause, soft frames) to the previous
   * sentence's last loud frame, at most farBackFrames back: if the converted
   * voice did not carry that frame, it stopped inside that sentence, and the
   * answer is its last alive pair; otherwise (or with nothing loud in reach)
   * the far end of the lookBackMs search, so a stop in a pause repeats nothing.
   */
  _lastAlive(j0, d, da) {
    const cap = this.cap;
    const hi = j0 + d - this.tol - 1;
    const oldest = this._frames - cap + (da > d ? da : d) + 1; // both frames of a pair still in the history
    const lo = Math.max(0, hi - this.backFrames + 1, oldest);
    // Two alive frames in a row: a concealment tail can cross the original's own decay for one frame.
    let k = hi;
    while (k > lo && !(this._alive(k, da) && this._alive(k - 1, da))) k--;
    if (k > lo) return k;
    const far = Math.max(0, hi - this.farBackFrames + 1, oldest);
    const loud = this._sp.db - this.speechRangeDb;
    let m = lo;
    while (m > far && !(m - da >= 0 && this._orig[(m - da) % cap] >= loud)) m--;
    if (m <= far || this._alive(m, da)) return k;
    while (m > far && !(this._alive(m, da) && this._alive(m - 1, da))) m--;
    return m > far ? m : k;
  }

  /**
   * Did converted frame k carry the voice of its original frame (k - d)?
   * Only a loud original frame can show it: next to a quiet one (a
   * syllable's tail, a pause) a concealment tail or noise looks as
   * plausible as the voice. Then the converted frame must be voice-level
   * and within aliveDb of the original frame plus the offset.
   */
  _alive(k, d) {
    const j = k - d;
    if (j < 0) return false;
    const o = this._orig[j % this.cap];
    const peak = this._sp.db;
    if (o < peak - this.speechRangeDb) return false;
    const c = this._conv[k % this.cap];
    return c >= peak + this._offset - this.voiceRangeDb && c >= o + this._offset - this.aliveDb;
  }

  /**
   * +jumpDb test for the newest converted frame k: against the original
   * frame it carries (k - d) plus the offset, but never against less than the
   * converted speech peak minus quietRefDb. That floor keeps a converted
   * syllable that arrives a little earlier or later than D (or speech while
   * the original is silent) from counting as a burst: only output far louder
   * than the user's own loudest speech does.
   */
  _checkJump(k, d) {
    let ref;
    if (d >= 0) {
      ref = k - d >= 0 ? this._orig[(k - d) % this.cap] : BELOW_ALL_DB;
    } else {
      ref = BELOW_ALL_DB; // D unknown: the loudest original frame it could carry
      for (let i = Math.max(0, k - this.searchFrames, k - this.cap + 1); i <= k; i++) {
        const v = this._orig[i % this.cap];
        if (v > ref) ref = v;
      }
    }
    ref += this._offset;
    const peak = this._sp.db;
    const quiet = peak > SILENCE_DB ? peak + this._offset - this.quietRefDb : JUMP_QUIET_DB;
    if (ref < quiet) ref = quiet;
    if (this._conv[k % this.cap] >= ref + this.jumpDb - JUMP_SLACK_DB) {
      this._jumpRun++;
      if (this._jumpRun >= this.jumpFrames && !this._stalled) this._bad = true;
    } else {
      this._jumpRun = 0;
    }
  }

  /** True once a stall was detected; sticky until reset(). */
  get stalled() {
    return this._stalled;
  }

  /** Content-time sample index (the original's sample count) where the converted voice stopped; null if not stalled. */
  get stallStartSample() {
    return this._stalled ? this._stallStart : null;
  }

  /**
   * While a miss run is open (missMs > 0, stalled or not yet): the content-time
   * sample index where it started, placed as stallStartSample is (where the
   * converted voice stopped carrying the user's speech; it errs early). Null
   * when no miss run is open. For a fault found elsewhere before the detector
   * has counted missingMs of speech (the main thread's packet watchdog): the
   * replay must start there, not where the listener is now.
   */
  get missStartSample() {
    return this._missRun > 0 ? this._runStart : null;
  }

  /** True if the converted stream had NaN/Inf, or a burst of >= jumpDb for >= jumpMs while not stalled; sticky until reset(). */
  get badOutput() {
    return this._bad;
  }

  /** True when the most recent decided original speech frame was matched by converted audio. */
  get following() {
    return this._following;
  }

  /** Ms of original speech matched by converted audio since the last miss run (>= healthResetMs) or reset(). */
  get healthyMs() {
    return this._healthy * this.frameMs;
  }

  /** Ms of original speech missing in the current miss run (0 while following). */
  get missMs() {
    return this._missRun * this.frameMs;
  }

  /** True while the converted stream keeps losing pieces where speech was due (see the file header). */
  get choppy() {
    return this._choppy;
  }

  /** Learned level offset, converted minus original, over matched speech (dB, ±maxOffsetDb). */
  get offsetDb() {
    return this._offset;
  }

  /** The original's recent speech peak that decided speech frames are measured against (dB; -Infinity before any speech). */
  get speechPeakDb() {
    return this._sp.db;
  }
}
