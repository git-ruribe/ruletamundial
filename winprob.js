// winprob.js — Poisson/Skellam in-play win probability model.
//
// Exposes window.WP = { calibrate, live }.
//
// calibrate(preProbs) → { lh, la } | null
//   Finds Poisson rates λh (home) and λa (away) that reproduce the
//   pre-match 1X2 probabilities {h, d, a} from Polymarket.
//   Two decoupled 1-D binary searches, 4 iterations each → converges in
//   ~320 sim calls (microseconds in JS).
//
// live(lh, la, elapsed, score) → { h, d, a }
//   Win probabilities given current game state. Convolves two truncated
//   Poisson distributions (K=13 buckets) over remaining time fraction
//   f = (FULL_MATCH − elapsed) / FULL_MATCH. O(K²) = 169 ops.
//
//   FULL_MATCH is 97, not 90: referees routinely add ~7 minutes of stoppage
//   in the second half (more at the 2026 World Cup). Anchoring at 90 makes the
//   model declare the game over at the 90' whistle while the market keeps
//   pricing the real added minutes — a spurious model-vs-market gap that grows
//   as the clock nears 90'. Using 97 keeps a small residual of remaining time
//   alive through stoppage. Calibration is unaffected: at elapsed=0, f=1.0
//   regardless of the constant.
//
// Sanity invariant: live(lh, la, 0, {home:0,away:0}) ≈ calibrate input.

(function () {
  'use strict';

  const K = 13; // truncate at 12 goals per side (P(X≥13) < 1e-6 for λ<5)

  // Effective match length in minutes: 90' regulation + ~7' average stoppage.
  // The remaining-time fraction f is measured against this, not 90, so the
  // model doesn't prematurely "end" the game at the 90' whistle. See header.
  const FULL_MATCH = 97;

  // Poisson PMF computed iteratively (avoids factorial overflow).
  function ppdf(lambda, k) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let p = Math.exp(-lambda);
    for (let i = 0; i < k; i++) p *= lambda / (i + 1);
    return p;
  }

  // Core simulation: given remaining rates and current score, sum outcomes.
  function sim(rlh, rla, gh, ga) {
    let ph = 0, pd = 0, pa = 0;
    for (let i = 0; i < K; i++) {
      const pi = ppdf(rlh, i);
      if (pi < 1e-12) continue;
      for (let j = 0; j < K; j++) {
        const p = pi * ppdf(rla, j);
        if (p < 1e-12) continue;
        const fh = gh + i, fa = ga + j;
        if (fh > fa) ph += p;
        else if (fh === fa) pd += p;
        else pa += p;
      }
    }
    const tot = ph + pd + pa;
    if (tot < 1e-10) {
      // Rates so small the result is already decided by current score.
      if (gh > ga) return { h: 1, d: 0, a: 0 };
      if (gh === ga) return { h: 0, d: 1, a: 0 };
      return { h: 0, d: 0, a: 1 };
    }
    return { h: ph / tot, d: pd / tot, a: pa / tot };
  }

  // Reconstruct λh, λa from pre-match {h, d, a} via two 1-D binary searches.
  // Step A: fix ratio r = λh/λa, binary-search total λ to match draw prob.
  // Step B: fix total λ, binary-search r to match home/away ratio.
  // Alternate A-B four times — converges well within calibration tolerance.
  function calibrate(preProbs) {
    const { h: ph, d: pd, a: pa } = preProbs || {};
    if (!(ph > 0.001 && pd > 0.001 && pa > 0.001)) return null;

    const targetRatio = ph / pa;
    // sqrt(ratio) is a good first guess: P(home)/P(away) ≈ (λh/λa)^k with k≈1.
    let ratio = Math.sqrt(targetRatio);
    // Rough λ_total starting point: more goals → fewer draws.
    let lTotal = Math.max(0.5, Math.min(-Math.log(pd) / 1.1, 9));

    const split = (t, r) => ({ lh: t * r / (1 + r), la: t / (1 + r) });

    for (let iter = 0; iter < 4; iter++) {
      // A: binary-search total to hit pd target.
      let lo = 0.3, hi = 10;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const { lh, la } = split(mid, ratio);
        sim(lh, la, 0, 0).d > pd ? (lo = mid) : (hi = mid);
      }
      lTotal = (lo + hi) / 2;

      // B: binary-search ratio to hit ph/pa target.
      lo = 0.005; hi = 1000;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const { lh, la } = split(lTotal, mid);
        const s = sim(lh, la, 0, 0);
        (s.h / (s.a || 1e-9)) < targetRatio ? (lo = mid) : (hi = mid);
      }
      ratio = (lo + hi) / 2;
    }

    const { lh, la } = split(lTotal, ratio);
    return { lh, la };
  }

  // In-play win probability given calibrated rates, current minute and score.
  function live(lh, la, elapsed, score) {
    // Cap at FULL_MATCH so f reaches 0 only at the very end. Note the feed
    // drops the "+N" from stoppage-time labels ("90+5" → 90), so during 2H
    // added time t typically sits at 90 and f holds ≈0.072 — exactly the
    // residual uncertainty we want while those minutes are still being played.
    const t = Math.min(Number(elapsed) || 0, FULL_MATCH);
    const f = Math.max(0, (FULL_MATCH - t) / FULL_MATCH);
    const gh = (score && Number.isFinite(score.home)) ? score.home : 0;
    const ga = (score && Number.isFinite(score.away)) ? score.away : 0;
    return sim(lh * f, la * f, gh, ga);
  }

  // Expose on window (the rest of the app is not ES-module based).
  if (typeof window !== 'undefined') window.WP = { calibrate, live };
  // Also support Node require() for tests.
  if (typeof module !== 'undefined') module.exports = { calibrate, live };
})();
