/**
 * Seeded PRNG (mulberry32).
 *
 * Every random decision in a match — role assignment, seating order, tie-breaks —
 * draws from one seeded stream so a session can be replayed exactly. Research
 * results that cannot be reproduced are anecdotes, and Mafia has enough variance
 * that an unseeded run tells you very little.
 */
class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.state = this.seed;
    this.draws = 0;
  }

  /** Uniform float in [0, 1). */
  next() {
    this.draws++;
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick(arr) {
    if (!arr.length) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates on a copy. */
  shuffle(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

function makeSeed(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = parseInt(explicit, 10);
    if (!Number.isNaN(n)) return n >>> 0;
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

module.exports = { Rng, makeSeed };
