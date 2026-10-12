// twinrun, reproducible randomized trials for agent-based models (Rust port).
// std-only. Byte-identical output to the Python reference (trial.py).
// Integer-only SplitMix64 with wrapping u64 arithmetic so there is no
// language-dependent PRNG or float behavior. The master seed is a plain u64,
// which has no precision loss at any value, unlike a JavaScript number.

const GOLD: u64 = 0x9E3779B97F4A7C15;

const N: usize = 200;
const DAYS: usize = 25;
const K: usize = 5;
const RECOVER: u32 = 5;
const SEEDS: usize = 3;

struct Rng {
    s: u64,
}

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng { s: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.s = self.s.wrapping_add(GOLD);
        let mut z = self.s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }

    fn hit_ppm(&mut self, ppm: u64) -> bool {
        (self.next_u64() % 1_000_000) < ppm
    }
}

// One SplitMix64 mixing round on its own, used to decorrelate a small integer (an agent id)
// before it seeds a stream. Without this, neighbouring agent ids land only GOLD apart on the
// SAME SplitMix64 orbit, so their draws are not independent, a real bug this fixes.
fn scramble(x: u64) -> u64 {
    let mut z = x.wrapping_add(GOLD);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn stream(master: u64, agent_id: u64) -> Rng {
    Rng::new(master ^ scramble(agent_id))
}

#[allow(clippy::too_many_arguments)]
fn step(
    i: usize,
    cur: &[u8],
    state: &mut [u8],
    days_inf: &mut [u32],
    rngs: &mut [Rng],
    named: bool,
    beta_ppm: u64,
) {
    if cur[i] == b'S' {
        let idx = if named { i } else { 0 };
        let rng = &mut rngs[idx];
        let mut infected_contacts: usize = 0;
        for _ in 0..K {
            let c = rng.below(N as u64) as usize;
            if cur[c] == b'I' {
                infected_contacts += 1;
            }
        }
        let mut got = false;
        for _ in 0..infected_contacts {
            if rng.hit_ppm(beta_ppm) {
                got = true;
            }
        }
        if got {
            state[i] = b'I';
            days_inf[i] = 0;
        }
    } else if cur[i] == b'I' {
        days_inf[i] += 1;
        if days_inf[i] >= RECOVER {
            state[i] = b'R';
        }
    }
}

fn sir(master: u64, beta_ppm: u64, named: bool, perturb: bool) -> (usize, Vec<u8>) {
    let mut rngs: Vec<Rng> = if named {
        (0..N).map(|i| stream(master, i as u64)).collect()
    } else {
        vec![stream(master, 0xABCDEF)]
    };
    let mut state: Vec<u8> = (0..N)
        .map(|i| if i < SEEDS { b'I' } else { b'S' })
        .collect();
    let mut days_inf: Vec<u32> = vec![0; N];
    for _ in 0..DAYS {
        let cur = state.clone();
        if perturb {
            for i in (0..N).rev() {
                step(i, &cur, &mut state, &mut days_inf, &mut rngs, named, beta_ppm);
            }
        } else {
            for i in 0..N {
                step(i, &cur, &mut state, &mut days_inf, &mut rngs, named, beta_ppm);
            }
        }
    }
    let final_count = state.iter().filter(|&&b| b != b'S').count();
    (final_count, state)
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xCBF29CE484222325;
    for &b in data {
        h = (h ^ (b as u64)).wrapping_mul(0x100000001B3);
    }
    h
}

fn ite(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b.iter()).filter(|(x, y)| x != y).count()
}

fn mean(xs: &[usize]) -> f64 {
    xs.iter().sum::<usize>() as f64 / xs.len() as f64
}

// The fingerprint covers master and beta_ppm too, not just the final state, so two different
// runs that happen to land on the same state (common at low beta) cannot collide.
fn fingerprint(master: u64, beta_ppm: u64, state: &[u8]) -> String {
    let mut header = Vec::with_capacity(12 + state.len());
    header.extend_from_slice(&master.to_be_bytes());
    header.extend_from_slice(&(beta_ppm as u32).to_be_bytes());
    header.extend_from_slice(state);
    format!("{:016x}", fnv1a(&header))
}

fn main() {
    let b0: u64 = 15000;
    let b1: u64 = 25000;
    let mut checks: Vec<(&str, bool)> = Vec::new();

    // Seed 523 carries a real secondary-infection chain (14 of 200 agents, not just the 3
    // seeded cases), unlike most seeds at this beta, which mostly die out at 3 to 6. It also
    // sits outside every other check's seed range (0-29, 0-9, 0-149, 100000-100149), so it
    // cannot collide with them.
    const CANON_SEED: u64 = 523;
    let (_, s1) = sir(CANON_SEED, b0, true, false);
    let fp = fingerprint(CANON_SEED, b0, &s1);
    let (_, s1b) = sir(CANON_SEED, b0, true, false);
    checks.push((
        "replay reproduces the fingerprint",
        fingerprint(CANON_SEED, b0, &s1b) == fp && fingerprint(CANON_SEED, b0, &s1b) == "53efcd55d473dd82",
    ));

    let arm_beta = |arm: &str| -> u64 {
        match arm {
            "placebo" => b0,
            "treatment" => b1,
            _ => b0,
        }
    };
    let placebo_matches_control = (0..10u64).all(|s| sir(s, arm_beta("placebo"), true, false).1 == sir(s, arm_beta("control"), true, false).1);
    let treatment_moves = (0..10u64).any(|s| sir(s, arm_beta("treatment"), true, false).1 != sir(s, arm_beta("control"), true, false).1);
    checks.push((
        "placebo arm is byte-identical to control",
        placebo_matches_control && treatment_moves,
    ));

    let (_, plain) = sir(7, b0, true, false);
    let (_, reord) = sir(7, b0, true, true);
    checks.push(("named streams survive an order change", plain == reord));

    let global_desync = (0..30u64)
        .filter(|&s| sir(s, b0, false, false).1 != sir(s, b0, false, true).1)
        .count()
        >= 5;
    checks.push((
        "global stream desyncs on an order change, as expected",
        global_desync,
    ));

    let m: usize = 150;
    let mut crn: Vec<usize> = Vec::new();
    let mut indep: Vec<usize> = Vec::new();
    for s in 0..m as u64 {
        let (_, st) = sir(s, b1, true, false);
        let (_, sc) = sir(s, b0, true, false);
        crn.push(ite(&st, &sc));
        let (_, st2) = sir(s, b1, true, false);
        let (_, sc2) = sir(s + 100000, b0, true, false);
        indep.push(ite(&st2, &sc2));
    }
    let mut named_p: Vec<usize> = Vec::new();
    let mut global_p: Vec<usize> = Vec::new();
    for s in 0..m as u64 {
        let (_, st) = sir(s, b1, true, true);
        let (_, sc) = sir(s, b0, true, false);
        named_p.push(ite(&st, &sc));
        let (_, stg) = sir(s, b1, false, true);
        let (_, scg) = sir(s, b0, false, false);
        global_p.push(ite(&stg, &scg));
    }

    let mut allgood = true;
    println!("=== correctness checks ===");
    for (name, ok) in &checks {
        println!("[{}] {}", if *ok { "PASS" } else { "FAIL" }, name);
        allgood = allgood && *ok;
    }
    println!();
    println!(
        "=== per-agent effect, agents flipped (mean over {} seeds) ===",
        m
    );
    println!(
        "coupled twins (named, CRN)      {:.1} agents differ, the real effect",
        mean(&crn)
    );
    println!(
        "independent runs                {:.1} agents differ, mostly chance noise",
        mean(&indep)
    );
    println!();
    println!("=== when the treatment reorders work ===");
    println!(
        "named streams stay coupled      {:.1} agents differ (true effect)",
        mean(&named_p)
    );
    println!(
        "global stream loses coupling    {:.1} agents differ (spurious)",
        mean(&global_p)
    );
    println!();
    println!(
        "CANONICAL FINGERPRINT (seed {}, beta 15000 ppm) = {}",
        CANON_SEED, fp
    );

    std::process::exit(if allgood { 0 } else { 1 });
}
