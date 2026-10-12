#!/usr/bin/env python3
"""twinrun, reproducible randomized trials for agent-based models (Python reference).

Portable core so the Python, Rust, and TypeScript builds produce the identical fingerprint.
Everything is integer-only on a SplitMix64 generator, so there is no language-dependent float
or PRNG behavior. Named per-agent streams keep common-random-number twins aligned even when a
treatment reorders work. The SIR model is a test fixture written here, not imported.

The master seed is a u64 (0 to 2**64-1). In Python that is just an int; the TypeScript build
types it as bigint for the same reason, since a plain JavaScript number loses precision above
2**53-1 and would silently corrupt a seed above that.
"""
import sys

MASK = (1 << 64) - 1
GOLD = 0x9E3779B97F4A7C15

N = 200
DAYS = 25
K = 5
RECOVER = 5
SEEDS = 3


def _scramble(x):
    """One SplitMix64 mixing round, used on its own to decorrelate a small integer (an agent
    id) before it seeds a stream. Without this, neighbouring agent ids land only GOLD apart on
    the SAME SplitMix64 orbit, so their draws are not independent, a real bug this fixes."""
    z = (x + GOLD) & MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
    return z ^ (z >> 31)


class Rng:
    """SplitMix64. Identical output in any language that wraps u64 arithmetic."""
    def __init__(self, seed):
        self.s = seed & MASK

    def next_u64(self):
        self.s = (self.s + GOLD) & MASK
        z = self.s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        return z ^ (z >> 31)

    def below(self, n):
        return self.next_u64() % n

    def hit_ppm(self, ppm):
        return (self.next_u64() % 1_000_000) < ppm


def stream(master, agent_id):
    return Rng((master & MASK) ^ _scramble(agent_id))


def sir(master, beta_ppm, named, perturb):
    if named:
        rngs = [stream(master, i) for i in range(N)]
        draw = lambda i: rngs[i]
    else:
        g = stream(master, 0xABCDEF)
        draw = lambda i: g
    state = bytearray(ord("I") if i < SEEDS else ord("S") for i in range(N))
    days_inf = [0] * N
    for _ in range(DAYS):
        order = range(N - 1, -1, -1) if perturb else range(N)
        cur = bytes(state)
        for i in order:
            if cur[i] == ord("S"):
                rng = draw(i)
                infected_contacts = 0
                for _ in range(K):
                    if cur[rng.below(N)] == ord("I"):
                        infected_contacts += 1
                got = False
                for _ in range(infected_contacts):
                    if rng.hit_ppm(beta_ppm):
                        got = True
                if got:
                    state[i] = ord("I")
                    days_inf[i] = 0
            elif cur[i] == ord("I"):
                days_inf[i] += 1
                if days_inf[i] >= RECOVER:
                    state[i] = ord("R")
    final = sum(1 for b in state if b != ord("S"))
    return final, bytes(state)


def fnv1a(data):
    h = 0xCBF29CE484222325
    for b in data:
        h = ((h ^ b) * 0x100000001B3) & MASK
    return h


def fingerprint(master, beta_ppm, state):
    # The fingerprint covers master and beta too, not just the final state, so two different
    # runs that happen to land on the same state (common at low beta) cannot collide.
    header = (master & MASK).to_bytes(8, "big") + (beta_ppm & 0xFFFFFFFF).to_bytes(4, "big")
    return f"{fnv1a(header + state):016x}"


def ite(a, b):
    return sum(1 for x, y in zip(a, b) if x != y)


def main():
    b0, b1 = 15000, 25000
    checks = []

    # Seed 523 carries a real secondary-infection chain (14 of 200 agents, not just the 3
    # seeded cases), unlike most seeds at this beta, which mostly die out at 3 to 6. It also
    # sits outside every other check's seed range (0-29, 0-9, 0-149, 100000-100149), so it
    # cannot collide with them.
    CANON_SEED = 523
    _, s1 = sir(CANON_SEED, b0, True, False)
    fp = fingerprint(CANON_SEED, b0, s1)
    _, s1b = sir(CANON_SEED, b0, True, False)
    checks.append(("replay reproduces the fingerprint", fingerprint(CANON_SEED, b0, s1b) == fp and fingerprint(CANON_SEED, b0, s1b) == "53efcd55d473dd82"))

    arm_beta = {"control": b0, "placebo": b0, "treatment": b1}
    placebo_matches_control = all(sir(s, arm_beta["placebo"], True, False)[1] == sir(s, arm_beta["control"], True, False)[1] for s in range(10))
    treatment_moves = any(sir(s, arm_beta["treatment"], True, False)[1] != sir(s, arm_beta["control"], True, False)[1] for s in range(10))
    checks.append(("placebo arm is byte-identical to control", placebo_matches_control and treatment_moves))

    _, plain = sir(7, b0, True, False)
    _, reord = sir(7, b0, True, True)
    checks.append(("named streams survive an order change", plain == reord))

    desync = sum(1 for s in range(30) if sir(s, b0, False, False)[1] != sir(s, b0, False, True)[1]) >= 5
    checks.append(("global stream desyncs on an order change, as expected", desync))

    M = 150
    crn, indep = [], []
    for s in range(M):
        _, st = sir(s, b1, True, False)
        _, sc = sir(s, b0, True, False)
        crn.append(ite(st, sc))
        _, st2 = sir(s, b1, True, False)
        _, sc2 = sir(s + 100000, b0, True, False)
        indep.append(ite(st2, sc2))
    named_p, global_p = [], []
    for s in range(M):
        _, st = sir(s, b1, True, True)
        _, sc = sir(s, b0, True, False)
        named_p.append(ite(st, sc))
        _, stg = sir(s, b1, False, True)
        _, scg = sir(s, b0, False, False)
        global_p.append(ite(stg, scg))

    allgood = True
    print("=== correctness checks ===")
    for name, ok in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        allgood = allgood and ok
    mean = lambda xs: sum(xs) / len(xs)
    print(f"\n=== per-agent effect, agents flipped (mean over {M} seeds) ===")
    print(f"coupled twins (named, CRN)      {mean(crn):.1f} agents differ, the real effect")
    print(f"independent runs                {mean(indep):.1f} agents differ, mostly chance noise")
    print(f"\n=== when the treatment reorders work ===")
    print(f"named streams stay coupled      {mean(named_p):.1f} agents differ (true effect)")
    print(f"global stream loses coupling    {mean(global_p):.1f} agents differ (spurious)")
    print(f"\nCANONICAL FINGERPRINT (seed {CANON_SEED}, beta 15000 ppm) = {fp}")
    return 0 if allgood else 1


if __name__ == "__main__":
    raise SystemExit(main())
