// Faithful TypeScript port of the Python SIR / SplitMix64 reference.
// RNG state and all RNG math use BigInt with a 64-bit mask after every
// add and multiply; only the final `% n` / `% 1000000` results become Number.

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

function stream(master: number, agentId: number): Rng {
  return new Rng((BigInt(master) & MASK) ^ ((BigInt(agentId) * GOLD) & MASK));
}

function sir(master: number, betaPpm: number, named: boolean, perturb: boolean): [number, Uint8Array] {
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

function fingerprint(master: number, betaPpm: number): string {
  const [, state] = sir(master, betaPpm, true, false);
  return fnv1a(state).toString(16).padStart(16, "0");
}

function main(): void {
  const b0 = 15000, b1 = 25000;
  const M = 150;
  let crnSum = 0, indepSum = 0, namedPSum = 0, globalPSum = 0;
  for (let s = 0; s < M; s++) {
    const a = sir(s, b1, true, false)[1];
    const b = sir(s, b0, true, false)[1];
    const c = sir(s + 100000, b0, true, false)[1];
    const d = sir(s, b1, true, true)[1];
    const e = sir(s, b1, false, true)[1];
    const f = sir(s, b0, false, false)[1];
    crnSum += ite(a, b);
    indepSum += ite(a, c);
    namedPSum += ite(d, b);
    globalPSum += ite(e, f);
  }
  const crn = crnSum / M;
  const indep = indepSum / M;
  const namedP = namedPSum / M;
  const globalP = globalPSum / M;
  const replay = fingerprint(42, b0) === fingerprint(42, b0) && fingerprint(42, b0) === "96079823e10779ff";
  const armBeta: { [k: string]: number } = { control: b0, placebo: b0, treatment: b1 };
  let placeboMatchesControl = true;
  let treatmentMoves = false;
  for (let s = 0; s < 10; s++) {
    if (!bytesEqual(sir(s, armBeta.placebo, true, false)[1], sir(s, armBeta.control, true, false)[1])) placeboMatchesControl = false;
    if (!bytesEqual(sir(s, armBeta.treatment, true, false)[1], sir(s, armBeta.control, true, false)[1])) treatmentMoves = true;
  }
  const placebo = placeboMatchesControl && treatmentMoves;
  const namedOrder = bytesEqual(sir(7, b0, true, false)[1], sir(7, b0, true, true)[1]);
  let globalDesyncCount = 0;
  for (let s = 0; s < 30; s++) {
    if (!bytesEqual(sir(s, b0, false, false)[1], sir(s, b0, false, true)[1])) globalDesyncCount++;
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
  console.log(`\nCANONICAL FINGERPRINT (seed 42, beta 15000 ppm) = ${fingerprint(42, b0)}`);
  process.exit(allgood ? 0 : 1);
}

main();
