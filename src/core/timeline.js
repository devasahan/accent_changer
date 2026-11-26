/**
 * The original (mic) voice as a timeline that can be replayed and caught up.
 *
 * When the converted voice stalls, the safety mixer puts the user's own voice
 * on the meeting, replayed from where the converted voice stopped following,
 * so no word is lost. That leaves the original running behind; this module
 * catches up by shortening pauses, never speech. Once a pause has lasted
 * `minPauseMs` it drops at most half of the rest of it, keeps at least
 * `keepPauseMs` of every pause, and keeps clear of where the next word
 * starts: the speech flag comes from a VAD and rises some 40 ms after a word's
 * first sound, so the last `guardMs` of a pause (and the newest `guardMs` of
 * an ongoing one) is dropped only when it is as quiet as the pause itself.
 * Nor does it drop, or land a skip in, anything louder than the pause's own
 * quiet (its quietest 10 ms, +6 dB): a word whose first sound is soft (an
 * "h", an "f", a breathy start) may stay under the VAD's threshold for a
 * hundred ms or more, a whole syllable's soft tail too, and the flag calls
 * all of it pause.
 * The other way round (the target lag grew, lip sync switched on) it holds
 * back: the voice stops in a pause and later goes on from the same sample, so
 * silence goes in and speech is never repeated or split. Nothing clicks: a
 * jump or skip crossfades over `fadeMs` (equal power); a skip or a restart
 * onto near-silent content just switches, with the last value before it
 * fading out over `fadeMs`, so the content after it comes out untouched.
 *
 * Positions are content time: the count of original samples written so far.
 * Pure, and it creates no arrays or objects per block (once the engine has
 * compiled it, nothing at all), so it runs unchanged in an AudioWorklet.
 */

const PLAY = 0; // reading at full gain
const FADE_IN = 1; // reading, gain rising (after a jump, a crossfaded skip, or a hold on loud content)
const HOLD = 2; // not reading: silence (before the first read, in a hold, or out of content)

const MAX_FADES = 4; // read heads still fading out at once (one per jump within fadeMs)
const RUN_CAP = 4096; // speech/pause runs remembered: one per flag change, far more than the history needs
const QUIET_FLOOR = 0.001; // -60 dBFS peak: quieter than this is never a word worth keeping
const CHUNK_MS = 10; // the quiet level of a pause is that of its quietest chunk this long
const SOFT_STEP = 0.002; // -54 dBFS: a jump in level this small is inaudible, so such content may start without a fade

export class OriginalTimeline {
  /**
   * @param {object} [options]
   * @param {number} [options.sampleRate]
   * @param {number} [options.historyMs] how far back jumpTo() can replay.
   * @param {number} [options.keepPauseMs] every pause keeps at least this much.
   * @param {number} [options.fadeMs] length of every crossfade, fade-in and fade-out tail.
   * @param {number} [options.minPauseMs] a pause is shortened only after it has lasted this long.
   * @param {number} [options.guardMs] the VAD's lag on a word's start, with margin (see the file header).
   * @param {number} [options.minSkipMs] in a pause still going on, skip at least this much at a time.
   */
  constructor({
    sampleRate = 48000,
    historyMs = 3000,
    keepPauseMs = 150,
    fadeMs = 5,
    minPauseMs = 60,
    guardMs = 80,
    minSkipMs = 10,
  } = {}) {
    const n = (ms) => Math.max(0, Math.round((ms * sampleRate) / 1000));
    this.sampleRate = sampleRate;
    this.historySamples = Math.max(1, n(historyMs));
    this.keepPauseSamples = n(keepPauseMs);
    this.fadeSamples = Math.max(1, n(fadeMs));
    this.minPauseSamples = n(minPauseMs);
    this.guardSamples = n(guardMs);
    this.minSkipSamples = Math.max(1, n(minSkipMs));
    // The history plus room for blocks in flight and fades.
    this._cap = this.historySamples + Math.max(n(500), 4 * this.fadeSamples);
    this._ring = new Float32Array(this._cap);
    this._writePos = 0;
    // Peak |x| of each CHUNK_MS chunk of content (chunk c is [c * chunkLen, (c + 1) * chunkLen)).
    this._chunkLen = Math.max(1, n(CHUNK_MS));
    this._chunkN = Math.ceil(this._cap / this._chunkLen) + 2;
    this._chunks = new Float32Array(this._chunkN);
    this._chunkCount = 0; // complete chunks
    this._chunkPeak = 0; // peak of the chunk being written
    this._chunkFill = 0;
    // How far the pause under the read head stays quiet (see _quietEnd), worked out once per read().
    this._qeReads = -1;
    this._qeRun = -1;
    this._qeFrom = 0;
    this._qeEnd = 0;
    // Speech flags as runs: [start of run k, start of run k+1) has flag k; the last run is open.
    this._runStart = new Float64Array(RUN_CAP);
    this._runFlag = new Uint8Array(RUN_CAP);
    this._runCount = 0;
    this._cursor = 0;
    const F = this.fadeSamples;
    this._fadeIn = new Float64Array(F);
    this._fadeOut = new Float64Array(F);
    for (let j = 0; j < F; j++) {
      const t = ((j + 0.5) / F) * (Math.PI / 2);
      this._fadeIn[j] = Math.sin(t);
      this._fadeOut[j] = Math.cos(t);
    }
    // The main read head: its position is the read position.
    this._pos = 0;
    this._state = HOLD;
    this._started = false;
    this._j = 0; // progress through a fade
    this._gain = 0; // gain it applied to the last output sample
    this._last = 0; // its last contribution to the output
    // Heads fading out after a jump.
    this._fPos = new Float64Array(MAX_FADES);
    this._fG0 = new Float64Array(MAX_FADES);
    this._fJ = new Int32Array(MAX_FADES);
    this._fLast = new Float64Array(MAX_FADES);
    this._fCount = 0;
    // A head that ran out of content leaves its last value here, decaying over fadeMs (no click).
    this._tail = 0;
    this._tailStep = 0;
    this._tailLeft = 0;
    this._dropRun = -1; // pause run where content was dropped, and how much
    this._dropped = 0;
    this._reads = 0;
    this._checkedAt = -1; // read() call of the last quiet check (at most one scan per block)
    this._decideFrom = 0; // no skip or hold is possible before this content position (speech, or a young pause)
  }

  /** Total samples written: the content time of the next sample. */
  get writePos() {
    return this._writePos;
  }

  /** writePos minus the read position: how far the output is behind the newest original. */
  get lagSamples() {
    return this._writePos - this._pos;
  }

  /**
   * Append the newest original block (content time advances by its length).
   * @param {Float32Array} block
   * @param {boolean} speech the VAD's state for this block. Missing (undefined
   *   or null) counts as speech: content of unknown kind is never shortened.
   */
  write(block, speech) {
    const n = block.length;
    if (!n) return;
    const flag = speech === undefined || speech === null || speech ? 1 : 0;
    if (this._runCount === 0 || this._runFlag[(this._runCount - 1) % RUN_CAP] !== flag) {
      const k = this._runCount % RUN_CAP;
      this._runStart[k] = this._writePos;
      this._runFlag[k] = flag;
      this._runCount++;
    }
    const ring = this._ring;
    const cap = this._cap;
    const len = this._chunkLen;
    let idx = this._writePos % cap;
    let peak = this._chunkPeak;
    let fill = this._chunkFill;
    for (let i = 0; i < n; i++) {
      let v = block[i];
      if (v - v !== 0) v = 0; // NaN and ±Infinity never enter the timeline
      ring[idx] = v;
      if (++idx === cap) idx = 0;
      if (v < 0) v = -v;
      if (v > peak) peak = v;
      if (++fill === len) {
        this._chunks[this._chunkCount++ % this._chunkN] = peak;
        peak = 0;
        fill = 0;
      }
    }
    this._chunkPeak = peak;
    this._chunkFill = fill;
    this._writePos += n;
    this._guardOverrun();
  }

  /**
   * Fill `out` with the original at the read position, then advance. In the
   * steady state the read position after this call is writePos -
   * targetLagSamples (target 0 after a write of the same length = passthrough,
   * bit-exact). Behind the target it catches up in pauses; ahead of it
   * (the target grew) it holds back with silence in a pause. Before the first
   * read the output is silence until the target lag is reached, then the
   * content starts exactly at the target lag.
   * @param {Float32Array} out
   * @param {number} targetLagSamples clamped to 0..historySamples
   */
  read(out, targetLagSamples) {
    const n = out.length;
    let target = Math.round(+targetLagSamples);
    if (!(target > 0)) target = 0;
    if (target > this.historySamples) target = this.historySamples;
    this._reads++;
    const ring = this._ring;
    const cap = this._cap;
    const F = this.fadeSamples;
    for (let i = 0; i < n; i++) {
      const rem = n - i;
      // Decide: catch up, hold back, or carry on.
      const state = this._state;
      if (state === PLAY) {
        if (this._fCount === 0 && this._pos >= this._decideFrom) {
          const projected = this._writePos - this._pos - rem; // the lag after this call if nothing changes
          if (projected > target) this._trySkip(projected - target);
          else if (projected < target) this._tryHold();
        }
      } else if (state === HOLD) {
        this._tryResume(target, rem);
      }

      // Render the main head, the heads fading out, and the tail.
      let s = 0;
      const st = this._state;
      if (st !== HOLD) {
        const p = this._pos;
        if (p < this._writePos) {
          const x = ring[p % cap];
          let v = x;
          if (st === PLAY) {
            this._gain = 1;
          } else {
            const g = this._fadeIn[this._j];
            v = g * x;
            this._gain = g;
            if (++this._j >= F) this._state = PLAY;
          }
          this._pos = p + 1;
          this._last = v;
          s = v;
        } else {
          // Out of content (read without a write): fall silent smoothly and wait.
          this._addTail(this._last);
          this._last = 0;
          this._gain = 0;
          this._state = HOLD;
        }
      }
      for (let h = 0; h < this._fCount; ) {
        const p = this._fPos[h];
        if (p < this._writePos) {
          const v = this._fG0[h] * this._fadeOut[this._fJ[h]] * ring[p % cap];
          s += v;
          this._fLast[h] = v;
          this._fPos[h] = p + 1;
          if (++this._fJ[h] >= F) this._removeFade(h);
          else h++;
        } else {
          this._addTail(this._fLast[h]);
          this._removeFade(h);
        }
      }
      if (this._tailLeft > 0) {
        s += this._tail;
        this._tail -= this._tailStep;
        if (--this._tailLeft === 0) this._tail = 0;
      }
      out[i] = s;
    }
  }

  /**
   * Replay: the next read starts at this content time, clamped to the history
   * (and to writePos), with a fadeMs crossfade from the previous read
   * position. A value that is not a finite number is ignored.
   * @param {number} contentSample
   */
  jumpTo(contentSample) {
    if (typeof contentSample !== "number" || !Number.isFinite(contentSample)) return;
    const lo = Math.max(0, this._writePos - this.historySamples);
    const to = Math.min(this._writePos, Math.max(lo, Math.round(contentSample)));
    if (to === this._pos && this._started && this._state !== HOLD) return; // already there
    this._jump(to);
    this._dropRun = -1;
    this._dropped = 0;
  }

  /**
   * Behind the target and reading a pause that has lasted minPauseMs: skip
   * part of it. At most half of the pause after its first minPauseMs is
   * dropped and keepPauseMs of it is kept; the skip lands with its fade-in
   * finished before the last guardMs of the pause, or inside that stretch
   * only when it is as quiet as the pause.
   */
  _trySkip(excess) {
    const pos = this._pos;
    const k = this._runAt(pos);
    if (!this._notBefore(k)) return;
    const rs = this._start(k);
    const open = k === this._runCount - 1;
    const re = open ? this._writePos : this._start(k + 1);
    const P = re - rs; // the pause as known so far (it grows while it goes on)
    const F = this.fadeSamples;
    const dropped = this._dropRun === k ? this._dropped : 0;
    let S = Math.min(excess, Math.floor((P - this.minPauseSamples) / 2) - dropped, P - this.keepPauseSamples - dropped);
    if (S <= 0) return;
    const safe = re - pos - F - this.guardSamples;
    if (S > safe) {
      // A closed pause: the fade-in stays inside it. An ongoing one: S <= excess
      // keeps the landing at or behind the target, so its content is there in time.
      const reach = open ? S : Math.min(S, re - pos - F);
      let quiet = false;
      if (reach > safe && this._checkedAt !== this._reads) {
        this._checkedAt = this._reads;
        // The whole stretch up to `re`, not only what the skip touches: a word
        // starts quietly, but by the time the VAD flags it (at `re`) it has
        // been loud for a while, and that loud part lies in this stretch.
        quiet = this._zoneQuiet(rs, re - this.guardSamples, re);
      }
      S = quiet ? reach : safe;
    }
    if (S <= 0) return;
    // Only quiet content is dropped, and the landing's fade-in is over before any sound.
    const loudAt = this._quietEnd(k, rs, re, pos);
    if (loudAt < re && S > loudAt - pos - F) S = loudAt - pos - F;
    if (S <= 0) return;
    if (open && S < this.minSkipSamples && S < excess) return; // the pause is still growing: skip later, in one go
    const hard = this._softAt(pos + S);
    if (!hard && open) {
      // A crossfade's fade-in reads on past writePos, into content not here
      // yet (a word may be starting there): keep that to half a fade.
      S = Math.min(S, re - pos - (F >> 1));
      if (S <= 0) return;
    }
    this._jump(pos + S, hard);
    this._dropRun = k;
    this._dropped = dropped + S;
  }

  /**
   * Ahead of the target and reading a pause that has lasted minPauseMs: stop
   * here (silence; the last value fades out in the tail) until the lag
   * reaches the target, then go on from this same sample. Nothing after the
   * stop is touched, so a word starting there comes out whole after the
   * silence. A word must not have started just before it, though: the
   * pause goes on for guardMs past here (a word would have been flagged by
   * then), or that stretch is as quiet as the pause; and the content here is
   * quiet (a hold inside a soft onset would split it).
   */
  _tryHold() {
    const pos = this._pos;
    const k = this._runAt(pos);
    if (!this._notBefore(k)) return;
    const rs = this._start(k);
    const open = k === this._runCount - 1;
    const re = open ? this._writePos : this._start(k + 1);
    if (this._quietEnd(k, rs, re, pos) <= pos) return;
    if (re - pos < this.guardSamples) {
      if (this._checkedAt === this._reads) return;
      this._checkedAt = this._reads;
      if (!this._zoneQuiet(rs, re - this.guardSamples, re)) return;
    }
    this._addTail(this._last);
    this._last = 0;
    this._gain = 0;
    this._state = HOLD;
  }

  /**
   * Can the head skip or hold in run k now? If not because it is speech (or a
   * pause younger than minPauseMs), nothing can change before its end (or the
   * minPauseMs point): note that so read() does not ask again every sample.
   */
  _notBefore(k) {
    if (!this._isPause(k)) {
      if (k >= 0) this._decideFrom = k === this._runCount - 1 ? this._writePos : this._start(k + 1);
      return false;
    }
    const ready = this._start(k) + this.minPauseSamples;
    if (this._pos < ready) {
      this._decideFrom = ready;
      return false;
    }
    return true;
  }

  /** Held (silent): start, or go on from the same sample, once the lag allows. */
  _tryResume(target, rem) {
    if (!this._started) {
      // Nothing played yet: silence until the target lag is there, then start
      // exactly at it. From the stream's first sample that needs no fade (the
      // output is the input delayed, bit-exact); joining later, mid-signal, does.
      const at = this._writePos - rem - target;
      if (at < this._pos) return;
      this._started = true;
      if (at === 0) {
        this._state = PLAY;
        return;
      }
      this._pos = Math.max(at, this._writePos - this._cap);
      this._decideFrom = 0;
      this._resume();
      return;
    }
    const avail = this._writePos - this._pos;
    if (avail < rem) return; // not enough content for the rest of this block yet
    // Silence goes only into pauses: a head that ran out of content elsewhere resumes at once.
    if (avail - rem >= target || !this._isPause(this._runAt(this._pos))) this._resume();
  }

  /** Go on from the read position: straight in when it starts near-silent, else with a fade-in. */
  _resume() {
    if (this._softAt(this._pos)) this._state = PLAY;
    else {
      this._state = FADE_IN;
      this._j = 0;
    }
  }

  /**
   * Move the main head to `to`. Normally the old position fades out over
   * fadeMs while the new one fades in. `hard` (only onto near-silent
   * content): the new position starts at full gain and the old one's last
   * value fades out in the tail, so nothing after `to` is faded.
   */
  _jump(to, hard = false) {
    if (hard) this._addTail(this._last);
    else if (this._state !== HOLD && this._gain > 0) this._addFade(this._pos, this._gain, this._last);
    this._pos = to;
    this._state = hard ? PLAY : FADE_IN;
    this._j = 0;
    this._gain = 0;
    this._last = 0;
    this._started = true;
    this._decideFrom = 0;
  }

  /** Does the content at p (already written) start near-silent? */
  _softAt(p) {
    const v = this._ring[p % this._cap];
    return (v < 0 ? -v : v) <= SOFT_STEP;
  }

  /**
   * Is the end of a pause ([zoneFrom, to), where the VAD may not have flagged
   * a starting word yet) no louder than the pause before it: its quietest
   * chunk, +6 dB (see _quietLimit)? Not merely as loud as the stretch just
   * before the zone: a soft first sound that has gone on for a while is that
   * loud too.
   */
  _zoneQuiet(rs, zoneFrom, to) {
    const oldest = this._writePos - this._cap;
    const from = Math.max(rs, zoneFrom, oldest);
    if (to <= from) return true;
    return this._peak(from, to) <= this._quietLimit(rs, from);
  }

  /**
   * The loudest peak that still counts as the quiet of the pause [rs, re):
   * twice (+6 dB) the peak of its quietest complete chunk, never under
   * QUIET_FLOOR (also when no chunk lies wholly inside). A chunk of digital
   * silence (a dropout) makes it QUIET_FLOOR: stricter, so that pause gives
   * back less, but a soft sound in it is never taken for its quiet.
   */
  _quietLimit(rs, re) {
    const len = this._chunkLen;
    const c1 = Math.min(Math.floor(re / len), this._chunkCount); // chunks [c0, c1) lie inside
    let m = Infinity;
    for (let c = Math.max(Math.ceil(rs / len), this._chunkCount - this._chunkN + 1); c < c1; c++) {
      const v = this._chunks[c % this._chunkN];
      if (v < m) m = v;
    }
    return m === Infinity ? QUIET_FLOOR : Math.max(QUIET_FLOOR, 2 * m);
  }

  /**
   * Where content stops being quiet at or after pos, in pause run k ([rs,
   * re)): the start of the chunk before the first one louder than the
   * pause's quiet (_quietLimit: a sound rising out of the quiet starts in
   * the chunk before it shows), or re. At most once per read() call: within
   * one call the head only moves forward and nothing is written, so the
   * answer stands.
   */
  _quietEnd(k, rs, re, pos) {
    if (this._qeReads === this._reads && this._qeRun === k && pos >= this._qeFrom) return this._qeEnd;
    const len = this._chunkLen;
    const limit = this._quietLimit(rs, re);
    let end = re;
    for (let c = Math.floor(pos / len); c * len < re; c++) {
      if (c <= this._chunkCount - this._chunkN) {
        end = Math.max(rs, c * len); // too old to tell: not quiet
        break;
      }
      const peak = c < this._chunkCount ? this._chunks[c % this._chunkN] : this._chunkPeak; // the chunk being written
      if (peak > limit) {
        end = Math.max(rs, (c - 1) * len);
        break;
      }
    }
    this._qeReads = this._reads;
    this._qeRun = k;
    this._qeFrom = pos;
    this._qeEnd = end;
    return end;
  }

  /** Peak |x| of content [from, to). */
  _peak(from, to) {
    const ring = this._ring;
    const cap = this._cap;
    let m = 0;
    let idx = from % cap;
    for (let p = from; p < to; p++) {
      const v = ring[idx];
      const a = v < 0 ? -v : v;
      if (a > m) m = a;
      if (++idx === cap) idx = 0;
    }
    return m;
  }

  /** Index of the run holding content position p, or -1 if unknown (too old). */
  _runAt(p) {
    const count = this._runCount;
    if (!count) return -1;
    const first = Math.max(0, count - RUN_CAP);
    // Usually p is in the cursor's run or the next one (the head moves forward).
    const k = this._cursor;
    if (k >= first && k < count && this._start(k) <= p) {
      if (k + 1 >= count || this._start(k + 1) > p) return k;
      if (k + 2 >= count || this._start(k + 2) > p) return (this._cursor = k + 1);
    }
    // Otherwise (a jump, or the first look in a while): the last run starting at or before p.
    let lo = first;
    let hi = count - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this._start(mid) <= p) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found >= 0) this._cursor = found;
    return found;
  }

  _start(k) {
    return this._runStart[k % RUN_CAP];
  }

  /** Unknown runs (k = -1, or forgotten) count as speech. */
  _isPause(k) {
    return k >= 0 && k >= this._runCount - RUN_CAP && this._runFlag[k % RUN_CAP] === 0;
  }

  _addFade(pos, g0, last) {
    if (this._fCount === MAX_FADES) {
      // Four jumps within fadeMs: let the quietest go (its last value decays in the tail).
      let q = 0;
      for (let h = 1; h < MAX_FADES; h++) {
        if (this._fG0[h] * this._fadeOut[this._fJ[h]] < this._fG0[q] * this._fadeOut[this._fJ[q]]) q = h;
      }
      this._addTail(this._fLast[q]);
      this._removeFade(q);
    }
    const h = this._fCount++;
    this._fPos[h] = pos;
    this._fG0[h] = g0;
    this._fJ[h] = 0;
    this._fLast[h] = last;
  }

  _removeFade(h) {
    const last = --this._fCount;
    if (h === last) return;
    this._fPos[h] = this._fPos[last];
    this._fG0[h] = this._fG0[last];
    this._fJ[h] = this._fJ[last];
    this._fLast[h] = this._fLast[last];
  }

  _addTail(v) {
    if (!v) return;
    this._tail += v;
    this._tailLeft = this.fadeSamples;
    this._tailStep = this._tail / this.fadeSamples;
  }

  /**
   * Writes went on without reads (misuse) and overwrote what a head still
   * needed: restart at the oldest kept content.
   */
  _guardOverrun() {
    const oldest = this._writePos - this._cap;
    for (let h = 0; h < this._fCount; ) {
      if (this._fPos[h] < oldest) {
        this._addTail(this._fLast[h]);
        this._removeFade(h);
      } else h++;
    }
    if (this._pos >= oldest) return;
    if (this._state !== HOLD) this._addTail(this._last);
    this._pos = this._writePos - this.historySamples;
    this._decideFrom = 0;
    this._gain = 0;
    this._last = 0;
    this._dropRun = -1;
    this._dropped = 0;
    if (this._started) {
      this._state = FADE_IN;
      this._j = 0;
    } else this._state = HOLD;
  }
}
