#!/usr/bin/env python3
"""trial, a tiny standalone harness for randomized experiments inside agent-based models.

Zero dependencies, no ties to any one model. It gives a simulation four things that general
ABM frameworks do not provide together: named per-agent random streams (so a treatment that
changes execution order does not desync the randomness), common-random-number twin arms,
a placebo arm that must come out byte-identical to control, and a SHA-256 manifest you can
replay to the same hash. The SIR toy model below is only a test fixture, written here, not
imported from anywhere.

The headline it demonstrates. With coupled twins you can measure a per-agent treatment effect,
counting exactly which agents the intervention flipped. Independent runs cannot, because almost
every agent differs by chance. And that coupling only survives a treatment that reorders work
if each agent owns its random stream; a single global stream silently loses it.
"""
import hashlib
import json
import random
import statistics

N = 200          # agents
DAYS = 25        # steps
K = 5            # contacts drawn per susceptible per day
RECOVER = 5      # days infectious before recovery
SEEDS = 3        # initial infections


def substream(master: int, name: str) -> random.Random:
    """A deterministic, independent RNG keyed by (master seed, stream name).

    The stream an agent uses depends only on its name, never on when it draws, so adding a
    draw elsewhere or reordering the agent loop leaves every other stream untouched. That is
    what keeps common-random-number twins aligned across arms."""
    h = hashlib.sha256(f"{master}|{name}".encode()).digest()
    return random.Random(int.from_bytes(h[:8], "big"))


def sir(master: int, beta: float, named: bool, perturb: bool):
    """Synchronous SIR outbreak. named picks per-agent streams vs one global stream.
    perturb reverses the agent iteration order, standing in for a treatment that reorders work.
    Returns final ever-infected count and the final per-agent state tuple (identity level)."""
    if named:
        streams = [substream(master, f"agent:{i}") for i in range(N)]
        draw = lambda i: streams[i]
    else:
        g = substream(master, "global")
        draw = lambda i: g
    state = ["I" if i < SEEDS else "S" for i in range(N)]
    days_inf = [0] * N
    for _ in range(DAYS):
        order = list(range(N))
        if perturb:
            order = order[::-1]
        cur = state[:]
        nxt = state[:]
        for i in order:
            if cur[i] == "S":
                rng = draw(i)
                contacts = [rng.randrange(N) for _ in range(K)]
                infected_contacts = sum(1 for c in contacts if cur[c] == "I")
                p = 1 - (1 - beta) ** infected_contacts
                if rng.random() < p:
                    nxt[i] = "I"
                    days_inf[i] = 0
            elif cur[i] == "I":
                days_inf[i] += 1
                if days_inf[i] >= RECOVER:
                    nxt[i] = "R"
        state = nxt
    final = sum(1 for s in state if s != "S")
    return final, tuple(state)


def state_hash(state) -> str:
    return hashlib.sha256("".join(state).encode()).hexdigest()[:16]


def ite(state_t, state_c) -> int:
    """Per-agent treatment effect: how many agents end in a different state under treatment."""
    return sum(1 for a, b in zip(state_t, state_c) if a != b)


def manifest(master, arms, state):
    code = hashlib.sha256(open(__file__, "rb").read()).hexdigest()[:16]
    return {"master_seed": master, "arms": arms, "code_sha": code, "state_sha": state_hash(state)}


def se(xs):
    return statistics.pstdev(xs) / (len(xs) ** 0.5)


def main():
    b0, b1 = 0.015, 0.025      # control and treatment infection rates
    checks = []

    # 1. Deterministic replay from a manifest.
    _, s1 = sir(42, b0, named=True, perturb=False)
    man = manifest(42, {"beta": b0}, s1)
    _, s_replay = sir(man["master_seed"], b0, named=True, perturb=False)
    checks.append(("replay reproduces the manifest hash", state_hash(s_replay) == man["state_sha"]))

    # 2. Placebo arm (treatment == control) is byte-identical to control under one seed.
    _, c = sir(7, b0, named=True, perturb=False)
    _, pl = sir(7, b0, named=True, perturb=False)
    checks.append(("placebo arm is byte-identical to control", state_hash(c) == state_hash(pl)))

    # 3. Named streams survive an order-changing treatment (identical final state).
    _, plain = sir(7, b0, named=True, perturb=False)
    _, reordered = sir(7, b0, named=True, perturb=True)
    checks.append(("named streams survive an order change", state_hash(plain) == state_hash(reordered)))

    # 4. A single global stream does NOT survive the reorder (final state differs).
    _, gp = sir(7, b0, named=False, perturb=False)
    _, gr = sir(7, b0, named=False, perturb=True)
    checks.append(("global stream desyncs on an order change, as expected", state_hash(gp) != state_hash(gr)))

    M = 150
    # 5. Aggregate effect (final count): CRN twins vs independent runs.
    paired_ate, indep_ate = [], []
    for s in range(M):
        t, _ = sir(s, b1, named=True, perturb=False)
        c0, _ = sir(s, b0, named=True, perturb=False)
        paired_ate.append(t - c0)
        t2, _ = sir(s, b1, named=True, perturb=False)
        c2, _ = sir(s + 100000, b0, named=True, perturb=False)
        indep_ate.append(t2 - c2)

    # 6. Per-agent effect (the thing only coupled twins can measure).
    crn_ite, indep_ite = [], []
    for s in range(M):
        _, st = sir(s, b1, named=True, perturb=False)
        _, sc = sir(s, b0, named=True, perturb=False)
        crn_ite.append(ite(st, sc))
        _, st2 = sir(s, b1, named=True, perturb=False)
        _, sc2 = sir(s + 100000, b0, named=True, perturb=False)
        indep_ite.append(ite(st2, sc2))

    # 7. Per-agent effect when the treatment reorders work: named keeps the coupling, global loses it.
    named_perturb_ite, global_perturb_ite = [], []
    for s in range(M):
        _, st = sir(s, b1, named=True, perturb=True)
        _, sc = sir(s, b0, named=True, perturb=False)
        named_perturb_ite.append(ite(st, sc))
        _, stg = sir(s, b1, named=False, perturb=True)
        _, scg = sir(s, b0, named=False, perturb=False)
        global_perturb_ite.append(ite(stg, scg))

    print("=== correctness checks ===")
    allgood = True
    for name, good in checks:
        print(f"[{'PASS' if good else 'FAIL'}] {name}")
        allgood = allgood and good

    print(f"\n=== aggregate effect, final-count difference over {M} seeds ===")
    print(f"paired, common random numbers     ATE = {statistics.mean(paired_ate):5.2f}  SE = {se(paired_ate):.3f}")
    print(f"independent, different seeds       ATE = {statistics.mean(indep_ate):5.2f}  SE = {se(indep_ate):.3f}")
    print(f"variance reduction from CRN        {se(indep_ate)/se(paired_ate):.1f}x tighter")

    print(f"\n=== per-agent effect, agents flipped by the treatment (mean over {M} seeds) ===")
    print(f"coupled twins (named, CRN)         {statistics.mean(crn_ite):6.1f} agents differ, the real effect")
    print(f"independent runs                   {statistics.mean(indep_ite):6.1f} agents differ, mostly chance noise")
    print(f"signal-to-noise gain               {statistics.mean(indep_ite)/statistics.mean(crn_ite):.1f}x cleaner")

    print(f"\n=== same per-agent effect when the treatment reorders work ===")
    print(f"named streams stay coupled         {statistics.mean(named_perturb_ite):6.1f} agents differ (matches the true effect)")
    print(f"global stream loses the coupling   {statistics.mean(global_perturb_ite):6.1f} agents differ (spurious, coupling destroyed)")

    print("\nmanifest example:", json.dumps(man))
    return 0 if allgood else 1


if __name__ == "__main__":
    raise SystemExit(main())
