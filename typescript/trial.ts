// Faithful TypeScript port of the Python SIR / SplitMix64 reference.
// RNG state and all RNG math use BigInt with a 64-bit mask after every
// add and multiply; only the final `% n` / `% 1000000` results become Number.
//
// The master seed is typed bigint, not number. A plain JavaScript number loses precision
// above 2**53-1, so a u64 seed above that would silently be rounded and give a different
// fingerprint than Python and Rust with no error. bigint avoids that.

const MASK = (1n << 64n) - 1n;
const GOLD = 0x9E3779B97F4A7C15n;
const N = 200, DAYS = 25, K = 5, RECOVER = 5, SEEDS = 3;
const CH_S = 83, CH_I = 73, CH_R = 82; // 'S','I','R'

class Rng {
  s: bigint;
  constructor(seed: bigint) {
    this.s = seed & MASK;
  }
  next_u64(): bigint {
    this.s = (this.s + GOLD) & MASK;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }
  below(n: number): number {
    return Number(this.next_u64() % BigInt(n));
  }
  hit_ppm(ppm: number): boolean {
    return Number(this.next_u64() % 1000000n) < ppm;
  }
}

// One SplitMix64 mixing round on its own, used to decorrelate a small integer (an agent id)
// before it seeds a stream. Without this, neighbouring agent ids land only GOLD apart on the
// SAME SplitMix64 orbit, so their draws are not independent, a real bug this fixes.
function scramble(x: bigint): bigint {
  let z = (x + GOLD) & MASK;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

function stream(master: bigint, agentId: number): Rng {
  return new Rng((master & MASK) ^ scramble(BigInt(agentId)));
}

function sir(master: bigint, betaPpm: number, named: boolean, perturb: boolean): [number, Uint8Array] {
  let rngs: Rng[] | null = null;
  let g: Rng | null = null;
  if (named) {
    rngs = [];
    for (let i = 0; i < N; i++) rngs.push(stream(master, i));
  } else {
    g = stream(master, 0xABCDEF);
  }
  const draw = (i: number): Rng => (named ? rngs![i] : g!);

  const state = new Uint8Array(N);
  for (let i = 0; i < N; i++) state[i] = i < SEEDS ? CH_I : CH_S;
  const daysInf = new Array<number>(N).fill(0);

  for (let day = 0; day < DAYS; day++) {
    const forward = !perturb;
    const cur = state.slice(); // synchronous day-start snapshot
    for (let idx = 0; idx < N; idx++) {
      const i = forward ? idx : (N - 1 - idx);
      if (cur[i] === CH_S) {
        const rng = draw(i);
        let infectedContacts = 0;
        for (let k = 0; k < K; k++) {
          if (cur[rng.below(N)] === CH_I) infectedContacts++;
        }
        let got = false;
        for (let c = 0; c < infectedContacts; c++) {
          if (rng.hit_ppm(betaPpm)) got = true;
        }
        if (got) {
          state[i] = CH_I;
          daysInf[i] = 0;
        }
      } else if (cur[i] === CH_I) {
        daysInf[i] += 1;
        if (daysInf[i] >= RECOVER) state[i] = CH_R;
      }
    }
  }

  let final = 0;
  for (let i = 0; i < N; i++) if (state[i] !== CH_S) final++;
  return [final, state];
}

function fnv1a(data: Uint8Array): bigint {
  let h = 0xCBF29CE484222325n;
  for (let i = 0; i < data.length; i++) {
    h = ((h ^ BigInt(data[i])) * 0x100000001B3n) & MASK;
  }
  return h;
}

function ite(a: Uint8Array, b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < N; i++) if (a[i] !== b[i]) c++;
  return c;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The fingerprint covers master and betaPpm too, not just the final state, so two different
// runs that happen to land on the same state (common at low beta) cannot collide.
function fingerprint(master: bigint, betaPpm: number): string {
  const [, state] = sir(master, betaPpm, true, false);
  const header = new Uint8Array(12);
  const dv = new DataView(header.buffer);
  dv.setBigUint64(0, master & MASK, false);
  dv.setUint32(8, betaPpm >>> 0, false);
  const combined = new Uint8Array(header.length + state.length);
  combined.set(header, 0);
  combined.set(state, header.length);
  return fnv1a(combined).toString(16).padStart(16, "0");
}

function main(): void {
  const b0 = 15000, b1 = 25000;
  const M = 150;
  let crnSum = 0, indepSum = 0, namedPSum = 0, globalPSum = 0;
  for (let s = 0; s < M; s++) {
    const a = sir(BigInt(s), b1, true, false)[1];
    const b = sir(BigInt(s), b0, true, false)[1];
    const c = sir(BigInt(s + 100000), b0, true, false)[1];
    const d = sir(BigInt(s), b1, true, true)[1];
    const e = sir(BigInt(s), b1, false, true)[1];
    const f = sir(BigInt(s), b0, false, false)[1];
    crnSum += ite(a, b);
    indepSum += ite(a, c);
    namedPSum += ite(d, b);
    globalPSum += ite(e, f);
  }
  const crn = crnSum / M;
  const indep = indepSum / M;
  const namedP = namedPSum / M;
  const globalP = globalPSum / M;

  // Seed 523 carries a real secondary-infection chain (14 of 200 agents, not just the 3
  // seeded cases), unlike most seeds at this beta, which mostly die out at 3 to 6. It also
  // sits outside every other check's seed range (0-29, 0-9, 0-149, 100000-100149), so it
  // cannot collide with them.
  const CANON_SEED = 523n;
  const replay = fingerprint(CANON_SEED, b0) === fingerprint(CANON_SEED, b0) && fingerprint(CANON_SEED, b0) === "53efcd55d473dd82";

  const armBeta: { [k: string]: number } = { control: b0, placebo: b0, treatment: b1 };
  let placeboMatchesControl = true;
  let treatmentMoves = false;
  for (let s = 0; s < 10; s++) {
    if (!bytesEqual(sir(BigInt(s), armBeta.placebo, true, false)[1], sir(BigInt(s), armBeta.control, true, false)[1])) placeboMatchesControl = false;
    if (!bytesEqual(sir(BigInt(s), armBeta.treatment, true, false)[1], sir(BigInt(s), armBeta.control, true, false)[1])) treatmentMoves = true;
  }
  const placebo = placeboMatchesControl && treatmentMoves;
  const namedOrder = bytesEqual(sir(7n, b0, true, false)[1], sir(7n, b0, true, true)[1]);
  let globalDesyncCount = 0;
  for (let s = 0; s < 30; s++) {
    if (!bytesEqual(sir(BigInt(s), b0, false, false)[1], sir(BigInt(s), b0, false, true)[1])) globalDesyncCount++;
  }
  const globalDesync = globalDesyncCount >= 5;

  const checks: [string, boolean][] = [
    ["replay reproduces the fingerprint", replay],
    ["placebo arm is byte-identical to control", placebo],
    ["named streams survive an order change", namedOrder],
    ["global stream desyncs on an order change, as expected", globalDesync],
  ];
  let allgood = true;
  console.log("=== correctness checks ===");
  for (const [name, ok] of checks) {
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
    allgood = allgood && ok;
  }
  console.log(`\n=== per-agent effect, agents flipped (mean over ${M} seeds) ===`);
  console.log(`coupled twins (named, CRN)      ${crn.toFixed(1)} agents differ, the real effect`);
  console.log(`independent runs                ${indep.toFixed(1)} agents differ, mostly chance noise`);
  console.log(`\n=== when the treatment reorders work ===`);
  console.log(`named streams stay coupled      ${namedP.toFixed(1)} agents differ (true effect)`);
  console.log(`global stream loses coupling    ${globalP.toFixed(1)} agents differ (spurious)`);
  console.log(`\nCANONICAL FINGERPRINT (seed ${CANON_SEED}, beta 15000 ppm) = ${fingerprint(CANON_SEED, b0)}`);
  process.exit(allgood ? 0 : 1);
}

main();
