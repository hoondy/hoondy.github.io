// LQ Test scoring.
//
// Everything about the questionnaire that does not depend on language lives here: the trait
// model, item keys, presentation order, norms and the composite. The page scores answers with
// it and the leaderboard worker re-scores submissions with the same code, so keep it free of
// DOM, timers and network calls. All wording lives in _data/leadership/<lang>.json.
//
// Answers are an array in ITEMS order (not presentation order):
//   likert     1..5  (strongly disagree .. strongly agree, as worded; reverse keys are applied here)
//   sjt        0..3  (index of the chosen option, in the order the options are listed)
//   attention  1..5
// scoreAnswers() also accepts an object keyed by item id.

export const VERSION = '1.1.0';

export const LANGS = Object.freeze(['en', 'ko', 'es', 'ja', 'zh']);

export const LQ_MEAN = 100;
export const LQ_SD = 15;
export const LQ_MIN = 55;
export const LQ_MAX = 145;

export const MIN_DURATION_MS = 90 * 1000;
export const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Dimensions
//
// `validity` is our working estimate of how strongly each kind of trait relates to leadership
// (corrected correlations from meta-analyses; emergence and effectiveness pooled), and the
// composite weights are simply proportional to it. Regression weights estimated from a
// meta-analytic matrix would look more precise but tend to be unstable, and roughly
// validity-proportional weights hold up well out of sample (Dawes, 1979).
//
//   drive          .36  dominance .37 (Judge et al., 2002); dominance .35 (Hoffman et al., 2011);
//                       the agentic side of extraversion carries its effect (Do & Minbashian, 2014)
//   presence       .22  sociability .37 (Judge et al., 2002) and energy .29 (Hoffman et al., 2011),
//                       discounted because the affiliative side of extraversion adds little once
//                       assertiveness is accounted for (Do & Minbashian, 2014)
//   dependability  .28  conscientiousness .28; achievement .35; dependability .30 (Judge et al., 2002)
//   composure      .22  neuroticism -.24 (Judge et al., 2002); self-confidence .24, adjustment .12
//                       (Hoffman et al., 2011)
//   vision         .24  openness .24 for both emergence and effectiveness (Judge et al., 2002);
//                       creativity .31 (Hoffman et al., 2011)
//   empathy        .14  agreeableness .08 overall but .21 for effectiveness (Judge et al., 2002);
//                       interpersonal skills .30, self-monitoring .19 (Hoffman et al., 2011)
//   motivation     .30  assumed. Motivation to lead adds prediction beyond personality and ability
//                       (Chan & Drasgow, 2001) and its three forms relate to both emergence and
//                       effectiveness (Badura et al., 2020); we use a value in line with the
//                       stronger Big Five correlates rather than a single pooled estimate.
//   decisiveness   .28  self-confidence .24 and decision making .52 (Hoffman et al., 2011);
//                       leadership self-efficacy predicted rated performance of Army cadets
//                       (Chemers et al., 2000)
//
// `norm` is the mean and SD of the 1..5 dimension score in the general adult population.
// These are provisional: they come from a response model whose item means and spreads follow
// typical IPIP item statistics (item means 2.3..3.8, SD about 1.1). The leaderboard stores only
// the LQ, so real norms would need answers collected separately, with consent; posted scores
// alone would also be a self-selected, high-scoring sample.

export const DIMENSIONS = [
  { id: 'drive', validity: 0.36, norm: { mean: 3.38, sd: 0.81 } },
  { id: 'presence', validity: 0.22, norm: { mean: 3.17, sd: 0.81 } },
  { id: 'dependability', validity: 0.28, norm: { mean: 3.56, sd: 0.79 } },
  { id: 'composure', validity: 0.22, norm: { mean: 3.32, sd: 0.80 } },
  { id: 'vision', validity: 0.24, norm: { mean: 3.44, sd: 0.80 } },
  { id: 'empathy', validity: 0.14, norm: { mean: 3.57, sd: 0.80 } },
  { id: 'motivation', validity: 0.30, norm: { mean: 3.30, sd: 0.82 } },
  { id: 'decisiveness', validity: 0.28, norm: { mean: 3.40, sd: 0.81 } },
];

const VALIDITY_SUM = DIMENSIONS.reduce((s, d) => s + d.validity, 0);
for (const d of DIMENSIONS) {
  d.weight = d.validity / VALIDITY_SUM;
  Object.freeze(d.norm);
  Object.freeze(d);
}
Object.freeze(DIMENSIONS);

export const DIM_IDS = Object.freeze(DIMENSIONS.map((d) => d.id));

// Assumed correlations between observed dimension scores, in DIMENSIONS order. Built from the
// meta-analytic Big Five intercorrelations of van der Linden et al. (2010) (observed r:
// E-O .31, E-C .21, E-A .18, E-N -.26, C-A .31, C-N -.32, A-N -.26, O-C .14, O-A .14, O-N -.12),
// mapped onto our narrower scales: drive and presence are the agentic and affiliative halves
// of extraversion, composure is reversed neuroticism, decisiveness overlaps with both
// assertiveness and emotional stability, and motivation to lead tracks extraversion most
// closely (Badura et al., 2020). The composite SD below is derived from this matrix, so if real
// data show different correlations, updating the matrix is enough to keep the LQ SD at 15.
export const DIM_CORRELATIONS = Object.freeze([
  //drive presence depend compos vision empath motiv decis
  [1.00, 0.43, 0.24, 0.27, 0.28, 0.04, 0.52, 0.47], // drive
  [0.43, 1.00, 0.12, 0.24, 0.23, 0.28, 0.31, 0.28], // presence
  [0.24, 0.12, 1.00, 0.27, 0.12, 0.23, 0.20, 0.31], // dependability
  [0.27, 0.24, 0.27, 1.00, 0.08, 0.20, 0.16, 0.44], // composure
  [0.28, 0.23, 0.12, 0.08, 1.00, 0.16, 0.20, 0.19], // vision
  [0.04, 0.28, 0.23, 0.20, 0.16, 1.00, 0.08, 0.04], // empathy
  [0.52, 0.31, 0.20, 0.16, 0.20, 0.08, 1.00, 0.39], // motivation
  [0.47, 0.28, 0.31, 0.44, 0.19, 0.04, 0.39, 1.00], // decisiveness
].map((row) => Object.freeze(row)));

// SD of the weighted sum of dimension z-scores: sqrt(w' R w). Dividing by it puts the
// composite back on a unit scale before it is mapped to mean 100, SD 15.
export const COMPOSITE_SD = Math.sqrt(
  DIMENSIONS.reduce(
    (s, a, i) => s + DIMENSIONS.reduce((t, b, j) => t + a.weight * b.weight * DIM_CORRELATIONS[i][j], 0),
    0,
  ),
);

// ---------------------------------------------------------------------------------------------
// Items
//
// 40 statements (5 per dimension, 20 of them reverse-keyed so agreeing with everything lands
// near the middle), 8 short scenarios (one per dimension, options scored 0..3 for how well they
// match effective leader behavior), and one instructed-response attention check. Statements
// are adapted from public-domain IPIP items (ipip.ori.org) or written for this test.
// `pair` links the three statement pairs that say opposite things; answering both the same
// way is what the consistency check looks for.

const L = (id, dim, key, pair) => ({ id, type: 'likert', dim, key, ...(pair ? { pair } : {}) });
const S = (id, dim, scores) => ({ id, type: 'sjt', dim, scores: Object.freeze(scores) });

export const ITEMS = [
  L('drive_1', 'drive', 1, 'drive_2'),
  L('drive_2', 'drive', -1, 'drive_1'),
  L('drive_3', 'drive', 1),
  L('drive_4', 'drive', 1),
  L('drive_5', 'drive', -1),

  L('presence_1', 'presence', 1),
  L('presence_2', 'presence', -1),
  L('presence_3', 'presence', 1),
  L('presence_4', 'presence', -1),
  L('presence_5', 'presence', -1),

  L('dependability_1', 'dependability', 1),
  L('dependability_2', 'dependability', -1),
  L('dependability_3', 'dependability', 1),
  L('dependability_4', 'dependability', 1),
  L('dependability_5', 'dependability', -1),

  L('composure_1', 'composure', 1, 'composure_4'),
  L('composure_2', 'composure', -1),
  L('composure_3', 'composure', 1),
  L('composure_4', 'composure', -1, 'composure_1'),
  L('composure_5', 'composure', -1),

  L('vision_1', 'vision', 1),
  L('vision_2', 'vision', -1),
  L('vision_3', 'vision', 1),
  L('vision_4', 'vision', 1),
  L('vision_5', 'vision', -1),

  L('empathy_1', 'empathy', 1),
  L('empathy_2', 'empathy', -1),
  L('empathy_3', 'empathy', 1),
  L('empathy_4', 'empathy', -1),
  L('empathy_5', 'empathy', -1),

  L('motivation_1', 'motivation', 1, 'motivation_2'),
  L('motivation_2', 'motivation', -1, 'motivation_1'),
  L('motivation_3', 'motivation', 1),
  L('motivation_4', 'motivation', 1),
  L('motivation_5', 'motivation', -1),

  L('decisiveness_1', 'decisiveness', 1),
  L('decisiveness_2', 'decisiveness', -1),
  L('decisiveness_3', 'decisiveness', 1),
  L('decisiveness_4', 'decisiveness', -1),
  L('decisiveness_5', 'decisiveness', -1),

  // Best option sits in a different position from scenario to scenario.
  S('sjt_1', 'drive', [0, 1, 3, 2]),
  S('sjt_2', 'composure', [0, 3, 2, 1]),
  S('sjt_3', 'empathy', [1, 0, 2, 3]),
  S('sjt_4', 'decisiveness', [3, 0, 2, 1]),
  S('sjt_5', 'motivation', [0, 3, 1, 2]),
  S('sjt_6', 'vision', [2, 1, 0, 3]),
  S('sjt_7', 'dependability', [3, 0, 1, 2]),
  S('sjt_8', 'presence', [1, 0, 3, 2]),

  // "Please select <scale label 2>": the page fills in the label so it always matches the scale.
  { id: 'check_1', type: 'attention', expect: 2 },
];

for (const it of ITEMS) Object.freeze(it);
Object.freeze(ITEMS);

export const ITEM_INDEX = Object.freeze(Object.fromEntries(ITEMS.map((it, i) => [it.id, i])));

export const CONSISTENCY_PAIRS = Object.freeze([
  ['drive_1', 'drive_2'],
  ['composure_1', 'composure_4'],
  ['motivation_1', 'motivation_2'],
]);

export const ATTENTION_ID = 'check_1';

// Presentation order. Each run of eight statements covers every dimension once with keys
// alternating, a scenario follows every five statements, the attention check sits a little
// past halfway, and the members of each consistency pair are far apart.
export const ITEM_ORDER = Object.freeze([
  'drive_1', 'empathy_1', 'composure_2', 'vision_1', 'presence_2',
  'sjt_1',
  'motivation_1', 'dependability_2', 'decisiveness_2', 'presence_1', 'composure_1',
  'sjt_3',
  'vision_2', 'decisiveness_3', 'empathy_2', 'drive_5', 'dependability_1',
  'sjt_2',
  'motivation_5', 'composure_3', 'presence_4', 'decisiveness_1', 'empathy_3',
  'sjt_5',
  'vision_5', 'dependability_5',
  'check_1',
  'drive_3', 'motivation_3',
  'sjt_4',
  'empathy_4', 'decisiveness_4', 'presence_3', 'vision_3', 'dependability_3',
  'sjt_6',
  'composure_5', 'drive_2', 'motivation_4', 'presence_5', 'drive_4',
  'sjt_7',
  'empathy_5', 'dependability_4', 'composure_4', 'vision_4', 'decisiveness_5',
  'sjt_8',
  'motivation_2',
]);

// ---------------------------------------------------------------------------------------------
// Archetypes
//
// The LQ says how much; the archetype says what kind. We compare the shape of a profile
// (each dimension's z minus the person's own average z) with a prototype shape per archetype
// and pick the closest by cosine similarity. A profile with little shape at all (spread of
// the eight z-scores below FLAT_PROFILE_SD, roughly one person in eleven) is an all-rounder.
// Prototypes are centered and normalized once below, so only their pattern matters.

export const FLAT_PROFILE_SD = 0.48;

export const ARCHETYPES = [
  { id: 'commander', profile: { drive: 1, decisiveness: 1, composure: 0.5, motivation: 0.3, empathy: -0.4, presence: -0.2 } },
  { id: 'visionary', profile: { vision: 1, drive: 0.5, motivation: 0.5, dependability: -0.4, composure: -0.2 } },
  { id: 'connector', profile: { presence: 1, empathy: 0.8, decisiveness: -0.3, vision: -0.1, dependability: -0.1 } },
  { id: 'anchor', profile: { dependability: 1, composure: 0.8, vision: -0.4, presence: -0.3, motivation: -0.2 } },
  { id: 'catalyst', profile: { presence: 0.8, motivation: 0.8, drive: 0.4, empathy: -0.2, dependability: -0.3, composure: -0.2 } },
  { id: 'strategist', profile: { vision: 0.8, dependability: 0.5, composure: 0.4, presence: -0.8, empathy: -0.2 } },
  { id: 'coach', profile: { empathy: 1, motivation: 0.4, dependability: 0.4, drive: -0.5, decisiveness: -0.2 } },
  { id: 'maverick', profile: { vision: 0.6, decisiveness: 0.6, drive: 0.4, motivation: -1, empathy: -0.4, dependability: -0.2 } },
  { id: 'allrounder', profile: null },
].map((a) => Object.freeze(a));
Object.freeze(ARCHETYPES);

const PROTOTYPES = ARCHETYPES.filter((a) => a.profile).map((a) => {
  const v = DIM_IDS.map((id) => a.profile[id] || 0);
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const c = v.map((x) => x - m);
  const n = Math.sqrt(c.reduce((s, x) => s + x * x, 0));
  return { id: a.id, v: c.map((x) => x / n) };
});

export const ARCHETYPE_IDS = Object.freeze(ARCHETYPES.map((a) => a.id));

// Score bands, highest first.
export const BANDS = Object.freeze([
  { id: 'exceptional', min: 130 },
  { id: 'strong', min: 115 },
  { id: 'solid', min: 100 },
  { id: 'emerging', min: 85 },
  { id: 'untapped', min: LQ_MIN },
].map((b) => Object.freeze(b)));

// ---------------------------------------------------------------------------------------------
// Answer quality

// Hard flags make a result invalid (shown with a warning, not accepted on the leaderboard).
export const HARD_FLAGS = Object.freeze([
  'incomplete', 'too_fast', 'attention', 'straightline', 'inconsistent', 'acquiescence', 'idealized', 'erratic',
]);

const PENALTY = {
  incomplete: 50, too_fast: 30, attention: 45, straightline: 45, inconsistent: 35,
  acquiescence: 35, idealized: 30, erratic: 30,
};
const PAIR_PENALTY = 8; // for each contradictory pair, flagged or not

const STRAIGHT_SHARE = 0.75; // share of statements given the same answer
const STRAIGHT_RUN = 12; // identical answers in a row, in presentation order
const PAIR_GAP = 3; // |a + b - 6| for an opposite-keyed pair; 3+ means agreeing (or disagreeing) with both
const PAIR_MIN = 2; // contradictory pairs needed to flag
const ACQ_GAP = 0.9; // |mean raw answer - 3|; with balanced keys honest answers sit near 3
const IDEAL_SHARE = 0.85; // share of statements at the most leader-like extreme
const ERRATIC_SD = 1.25; // mean within-dimension SD of keyed answers

// ---------------------------------------------------------------------------------------------
// Math

// Standard normal CDF. West's (2005) double-precision version of Hart's algorithm; absolute
// error below 1e-14, which is far more than a percentile needs but costs nothing.
export function normalCdf(x) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? NaN : x > 0 ? 1 : 0;
  const z = Math.abs(x);
  let c;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      c = e / d / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

const round = (x, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Percentile for a given LQ. Derived from the rounded LQ so that the same LQ always shows the
// same percentile, on the page, in share text and on the leaderboard.
export function pctFromLq(lq) {
  return round(clamp(normalCdf((lq - LQ_MEAN) / LQ_SD) * 100, 0.1, 99.9), 1);
}

export function bandFor(lq) {
  return (BANDS.find((b) => lq >= b.min) || BANDS[BANDS.length - 1]).id;
}

// "If you joined a group of five strangers, how likely is it that you'd end up leading it?"
// Emergence propensity is standard normal in the population and correlates EMERGENCE_R with
// the LQ composite, so given your LQ your propensity T ~ N(r·z, 1 - r²). You lead the group if
// T beats the propensities of four random others: P = E[Φ(T)^4], integrated numerically.
// EMERGENCE_R is set below the meta-analytic multiple R of .53 for emergence (Judge et al.,
// 2002) because a short online test measures the traits less precisely than the studies did.
// Averaged over everyone this is 20%, pure chance; someone at exactly LQ 100 gets 19%.
export const EMERGENCE_R = 0.35;
export const EMERGENCE_GROUP = 5;

export function emergenceFromLq(lq) {
  const m = EMERGENCE_R * ((lq - LQ_MEAN) / LQ_SD);
  const s = Math.sqrt(1 - EMERGENCE_R ** 2);
  // Simpson's rule over m ± 8s; 200 panels put the error far below the 1% we display.
  const n = 200;
  const h = (16 * s) / n;
  let acc = 0;
  for (let i = 0; i <= n; i++) {
    const t = m - 8 * s + i * h;
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    acc += w * Math.exp(-0.5 * ((t - m) / s) ** 2) * normalCdf(t) ** (EMERGENCE_GROUP - 1);
  }
  return Math.round(((acc * h) / 3 / (s * Math.sqrt(2 * Math.PI))) * 100);
}

// ---------------------------------------------------------------------------------------------
// Scoring

function isInt(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function validValue(item, v) {
  if (item.type === 'sjt') return isInt(v, 0, 3);
  return isInt(v, 1, 5);
}

function readAnswers(answers) {
  const out = new Array(ITEMS.length).fill(null);
  if (Array.isArray(answers)) {
    ITEMS.forEach((it, i) => {
      if (validValue(it, answers[i])) out[i] = answers[i];
    });
  } else if (answers && typeof answers === 'object') {
    ITEMS.forEach((it, i) => {
      const v = answers[it.id];
      if (validValue(it, v)) out[i] = v;
    });
  }
  return out;
}

// SJT scores (0..3) share the 1..5 scale of the statements so each scenario counts like one item.
const sjtToScale = (s) => 1 + (4 * s) / 3;

function sd(values) {
  if (values.length < 2) return 0;
  const m = values.reduce((s, x) => s + x, 0) / values.length;
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
}

function archetypeFor(zs) {
  const m = zs.reduce((s, x) => s + x, 0) / zs.length;
  const c = zs.map((x) => x - m);
  const spread = Math.sqrt(c.reduce((s, x) => s + x * x, 0) / c.length);
  if (spread < FLAT_PROFILE_SD) return 'allrounder';
  let best = null;
  let bestSim = -Infinity;
  for (const p of PROTOTYPES) {
    const sim = p.v.reduce((s, x, i) => s + x * c[i], 0);
    if (sim > bestSim) {
      bestSim = sim;
      best = p.id;
    }
  }
  return best;
}

/**
 * Score a set of answers.
 * @param {Array<number>|Object<string, number>} answers  in ITEMS order, or keyed by item id
 * @param {{durationMs?: number}} [opts]  time from first question to last answer
 * @returns {{
 *   version: string, valid: boolean, validity: number, flags: string[],
 *   lq: number, z: number, percentile: number, band: string, emergence: number,
 *   dims: Object<string, {score: number, z: number, percentile: number}>,
 *   archetype: string, strengths: string[], growth: string[],
 *   answered: number, total: number
 * }}
 */
export function scoreAnswers(answers, { durationMs } = {}) {
  const a = readAnswers(answers);
  const flags = [];
  let penalty = 0;
  const flag = (f) => {
    if (!flags.includes(f)) {
      flags.push(f);
      penalty += PENALTY[f] || 0;
    }
  };

  const answered = a.filter((v) => v !== null).length;
  if (answered < ITEMS.length) flag('incomplete');

  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs < MIN_DURATION_MS) {
    flag('too_fast');
  }

  const att = a[ITEM_INDEX[ATTENTION_ID]];
  if (att !== null && att !== ITEMS[ITEM_INDEX[ATTENTION_ID]].expect) flag('attention');

  // Statement answers in the order they were shown.
  const shown = ITEM_ORDER.map((id) => ITEMS[ITEM_INDEX[id]])
    .filter((it) => it.type === 'likert')
    .map((it) => a[ITEM_INDEX[it.id]])
    .filter((v) => v !== null);

  if (shown.length) {
    const counts = [0, 0, 0, 0, 0, 0];
    let run = 1;
    let longest = 1;
    shown.forEach((v, i) => {
      counts[v]++;
      if (i > 0) {
        run = v === shown[i - 1] ? run + 1 : 1;
        longest = Math.max(longest, run);
      }
    });
    if (Math.max(...counts) / shown.length >= STRAIGHT_SHARE || longest >= STRAIGHT_RUN) flag('straightline');

    const rawMean = shown.reduce((s, v) => s + v, 0) / shown.length;
    if (Math.abs(rawMean - 3) >= ACQ_GAP) flag('acquiescence');
  }

  let contradictions = 0;
  for (const [p, q] of CONSISTENCY_PAIRS) {
    const x = a[ITEM_INDEX[p]];
    const y = a[ITEM_INDEX[q]];
    if (x !== null && y !== null && Math.abs(x + y - 6) >= PAIR_GAP) contradictions++;
  }
  penalty += contradictions * PAIR_PENALTY;
  if (contradictions >= PAIR_MIN) flag('inconsistent');

  // Per-dimension scores.
  const keyedByDim = Object.fromEntries(DIM_IDS.map((id) => [id, []]));
  const scaleByDim = Object.fromEntries(DIM_IDS.map((id) => [id, []]));
  let likertCount = 0;
  let idealCount = 0;
  ITEMS.forEach((it, i) => {
    const v = a[i];
    if (v === null) return;
    if (it.type === 'likert') {
      const k = it.key > 0 ? v : 6 - v;
      keyedByDim[it.dim].push(k);
      scaleByDim[it.dim].push(k);
      likertCount++;
      if (k === 5) idealCount++;
    } else if (it.type === 'sjt') {
      scaleByDim[it.dim].push(sjtToScale(it.scores[v]));
    }
  });

  if (likertCount && idealCount / likertCount >= IDEAL_SHARE) flag('idealized');

  // Random clicking shows up as statements about the same trait pulling in opposite directions.
  const spreads = DIM_IDS.filter((id) => keyedByDim[id].length > 1).map((id) => sd(keyedByDim[id]));
  if (spreads.length && spreads.reduce((s, x) => s + x, 0) / spreads.length >= ERRATIC_SD) flag('erratic');

  const dims = {};
  const zs = [];
  let composite = 0;
  for (const d of DIMENSIONS) {
    const vals = scaleByDim[d.id];
    const mean = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : d.norm.mean;
    const z = (mean - d.norm.mean) / d.norm.sd;
    zs.push(z);
    composite += d.weight * z;
    dims[d.id] = {
      score: Math.round(((mean - 1) / 4) * 100),
      z: round(z, 2),
      percentile: Math.round(clamp(normalCdf(z) * 100, 1, 99)),
    };
  }

  const zLq = composite / COMPOSITE_SD;
  const lq = Math.round(clamp(LQ_MEAN + LQ_SD * zLq, LQ_MIN, LQ_MAX));

  const order = DIM_IDS.map((id, i) => ({ id, z: zs[i] })).sort((p, q) => q.z - p.z);
  const strengths = order.slice(0, 3).map((x) => x.id);
  const growth = order.slice(-2).reverse().map((x) => x.id);

  return {
    version: VERSION,
    valid: !flags.some((f) => HARD_FLAGS.includes(f)),
    validity: clamp(100 - penalty, 0, 100),
    flags,
    lq,
    z: round((lq - LQ_MEAN) / LQ_SD, 2),
    percentile: pctFromLq(lq),
    band: bandFor(lq),
    emergence: emergenceFromLq(lq),
    dims,
    archetype: archetypeFor(zs),
    strengths,
    growth,
    answered,
    total: ITEMS.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Leaderboard

const fail = (error) => ({ ok: false, error });

// Order matters only for which reason gets reported when several apply.
const REJECT_ORDER = ['incomplete', 'too_fast', 'attention', 'straightline', 'acquiescence', 'inconsistent', 'erratic', 'idealized'];

/**
 * Server-side check for a leaderboard submission. The client never sends a score; the
 * answers are re-scored here. `name` is cleaned by the worker, not here.
 * body: { name, answers: number[ITEMS.length], lang, durationMs }
 */
export function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad_body');
  const { answers, lang, durationMs } = body;

  if (typeof lang !== 'string' || !LANGS.includes(lang)) return fail('bad_lang');

  if (!Array.isArray(answers) || answers.length !== ITEMS.length) return fail('bad_answers');
  for (let i = 0; i < ITEMS.length; i++) {
    if (!validValue(ITEMS[i], answers[i])) return fail('bad_answers');
  }

  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    return fail('bad_duration');
  }
  if (durationMs < MIN_DURATION_MS) return fail('too_fast');

  const r = scoreAnswers(answers, { durationMs });
  if (!r.valid) return fail(REJECT_ORDER.find((f) => r.flags.includes(f)) || 'invalid');

  return { ok: true, score: r.lq, detail: { archetype: r.archetype, pct: r.percentile, lang } };
}

// ---------------------------------------------------------------------------------------------
// Shareable result code
//
// A short, URL-safe code for ?r=: version, LQ, archetype and the eight dimension percentiles,
// in base 36 with a check character. It only drives what a shared link displays; anyone can
// make one up, which is fine because the leaderboard never trusts it.
//
//   [0]      format version ('a')
//   [1..2]   LQ - LQ_MIN            (0..90)
//   [3]      archetype index        (0..8)
//   [4..19]  dimension percentiles  (2 chars each, DIMENSIONS order, 1..99)
//   [20]     check character

const CODE_VERSION = 'a';
const CODE_LENGTH = 21;
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function checkChar(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum = (sum * 31 + B36.indexOf(s[i]) + 7) % 1679;
  return B36[sum % 36];
}

const enc = (n, width) => n.toString(36).padStart(width, '0');

export function encodeResult(r) {
  if (!r || !Number.isInteger(r.lq) || !r.dims) return '';
  const arch = ARCHETYPE_IDS.indexOf(r.archetype);
  if (arch < 0) return '';
  let s = CODE_VERSION + enc(clamp(r.lq, LQ_MIN, LQ_MAX) - LQ_MIN, 2) + enc(arch, 1);
  for (const id of DIM_IDS) s += enc(clamp(Math.round(r.dims[id]?.percentile ?? 50), 1, 99), 2);
  return s + checkChar(s);
}

/** Returns { lq, percentile, band, emergence, archetype, dims: { id: percentile } } or null. */
export function decodeResult(code) {
  if (typeof code !== 'string') return null;
  const s = code.trim().toLowerCase();
  if (s.length !== CODE_LENGTH || s[0] !== CODE_VERSION || !/^[0-9a-z]+$/.test(s)) return null;
  if (checkChar(s.slice(0, -1)) !== s[CODE_LENGTH - 1]) return null;

  const lq = parseInt(s.slice(1, 3), 36) + LQ_MIN;
  const arch = parseInt(s[3], 36);
  if (lq > LQ_MAX || arch >= ARCHETYPE_IDS.length) return null;

  const dims = {};
  for (let i = 0; i < DIM_IDS.length; i++) {
    const p = parseInt(s.slice(4 + i * 2, 6 + i * 2), 36);
    if (!(p >= 1 && p <= 99)) return null;
    dims[DIM_IDS[i]] = p;
  }
  return { lq, percentile: pctFromLq(lq), band: bandFor(lq), emergence: emergenceFromLq(lq), archetype: ARCHETYPE_IDS[arch], dims };
}
