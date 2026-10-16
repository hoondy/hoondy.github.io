// sin, cos, exp and log that come out bit for bit the same in every JavaScript engine.
//
// The records board replays each match on the server, and the server's engine is rarely the
// one the match was played in. JavaScript only pins down + - * /, Math.sqrt and rounding
// exactly; Math.sin, Math.exp and the rest may differ in the last bit from one engine to the
// next, and over a few thousand physics steps that is enough to move a crater. So everything
// that decides where a shell lands goes through these instead. They use nothing but exact
// operations: range reduction, then a fixed polynomial. Error is around 1e-16 relative.

// pi/2 in two parts. PIO2_HI has only 33 significant bits, so n * PIO2_HI is exact for any n
// we will see, and the reduction loses nothing.
const PIO2_HI = 1.5707963267341256e+0;
const PIO2_LO = 6.077100506506192e-11;
const INV_PIO2 = 6.366197723675814e-1;

// Minimax coefficients for sin and cos on [-pi/4, pi/4] (the classic fdlibm kernels).
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

function ksin(x) {
  const z = x * x;
  return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function kcos(x) {
  const z = x * x;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

// Returns the quadrant and writes the reduced argument to R[0].
const R = [0];
function reduce(x) {
  const n = Math.round(x * INV_PIO2);
  R[0] = x - n * PIO2_HI - n * PIO2_LO;
  return ((n % 4) + 4) % 4;
}

export function sin(x) {
  if (!Number.isFinite(x)) return NaN;
  const q = reduce(x);
  const r = R[0];
  return q === 0 ? ksin(r) : q === 1 ? kcos(r) : q === 2 ? -ksin(r) : -kcos(r);
}

export function cos(x) {
  if (!Number.isFinite(x)) return NaN;
  const q = reduce(x);
  const r = R[0];
  return q === 0 ? kcos(r) : q === 1 ? -ksin(r) : q === 2 ? -kcos(r) : ksin(r);
}

// ln 2 in two parts; LN2_HI has 32 significant bits, so k * LN2_HI is exact for |k| < 2^21.
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+0;
const SQRT2 = 1.4142135623730951;
const TWO32 = 4294967296;
const INV_TWO32 = 1 / 4294967296;

// 1/n! for the exp series. |r| <= ln2/2 after reduction, so the terms up to r^14 reach well
// past 1e-17. (n! is exact in a double for every n here.)
const F2 = 1 / 2;
const F3 = 1 / 6;
const F4 = 1 / 24;
const F5 = 1 / 120;
const F6 = 1 / 720;
const F7 = 1 / 5040;
const F8 = 1 / 40320;
const F9 = 1 / 362880;
const F10 = 1 / 3628800;
const F11 = 1 / 39916800;
const F12 = 1 / 479001600;
const F13 = 1 / 6227020800;
const F14 = 1 / 87178291200;

// 2^k for every k exp can need, built by halving and doubling, which is exact all the way down
// into the subnormals (2^-1075 rounds to 0, as it should).
const BIAS = 1075;
const POW2 = new Float64Array(BIAS + 1024);
POW2[BIAS] = 1;
for (let i = BIAS + 1; i < POW2.length; i++) POW2[i] = POW2[i - 1] * 2;
for (let i = BIAS - 1; i >= 0; i--) POW2[i] = POW2[i + 1] * 0.5;

export function exp(x) {
  if (x !== x) return NaN;
  if (x > 709.78) return Infinity;
  if (x < -745.2) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  const p = 1 + r * (1 + r * (F2 + r * (F3 + r * (F4 + r * (F5 + r * (F6 + r * (F7 + r * (F8 + r * (F9 + r * (F10 + r * (F11 + r * (F12 + r * (F13 + r * F14)))))))))))));
  return k > 1023 ? p * 2 * POW2[k - 1 + BIAS] : p * POW2[k + BIAS];
}

// log(x) = e ln 2 + 2 atanh(s), with x = m 2^e, m in [sqrt(2)/2, sqrt(2)] and s = (m-1)/(m+1),
// so |s| < 0.172 and the odd series for atanh is done after 11 terms.
const ATANH = [];
for (let i = 0; i <= 11; i++) ATANH.push(1 / (2 * i + 1));

export function log(x) {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let m = x;
  let e = 0;
  // Exact rescaling by powers of two; big jumps first so tiny or huge inputs stay quick.
  while (m >= TWO32) {
    m *= INV_TWO32;
    e += 32;
  }
  while (m < INV_TWO32) {
    m *= TWO32;
    e -= 32;
  }
  while (m >= 2) {
    m *= 0.5;
    e++;
  }
  while (m < 1) {
    m *= 2;
    e--;
  }
  if (m > SQRT2) {
    m *= 0.5;
    e++;
  }
  const s = (m - 1) / (m + 1);
  const z = s * s;
  let p = ATANH[11];
  for (let i = 10; i >= 0; i--) p = ATANH[i] + z * p;
  return e * LN2_HI + (2 * s * p + e * LN2_LO);
}
