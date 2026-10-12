# Reproducible randomized trials for agent-based models

Working name twinrun. Run a change to a simulation against a perfectly matched twin run,
measure exactly which individuals the change affected, and prove the result replays to the
same hash. One small Python file, zero dependencies, not tied to any one model.

## The problem it solves

Agent-based models are full of randomness, so when you test whether an intervention changes an
outcome, the real effect hides inside run-to-run noise. The same randomness also makes these
models hard to reproduce, which is a live complaint in simulation science. General frameworks
such as Mesa and Agents.jl do not give you matched experiments and verified replay together.

## What it gives you

- Twin arms on common random numbers. Run the model twice from the same randomness, once with
  the change and once without, so any difference is the change and not luck.
- A per-individual effect. Coupled twins let you count exactly which agents the change flipped.
  Independent runs cannot, because almost every agent differs by chance.
- A placebo arm. A no-op intervention must come out byte-identical to control, so a drift there
  is a bug the harness catches.
- Verified replay. Every run carries a SHA-256 manifest, so a reviewer reruns it and lands on
  the identical result.

The one design rule that makes this hold is named per-agent random streams. Each agent owns its
stream, so a treatment that reorders work does not shuffle who draws what. A single global stream
silently loses the coupling the moment execution order changes.

## Proof, on a fresh SIR test model

Running `python3 trial.py` reproduces these results. The SIR model in the file is only a test
fixture, written here, not imported from anywhere.

- Four invariants pass. Deterministic replay to a manifest hash, placebo byte-identical to
  control, named streams survive an order change, a global stream desyncs on one.
- The per-individual effect is 3.0 agents under coupled twins and 6.1 under independent runs,
  where roughly half of the independent figure is chance.
- When the treatment reorders work, named streams hold at the true 3.0 while a global stream
  inflates to 5.5 spurious flips.

## Status

Early. This is the standalone core, extracted from a reproducible marriage and divorce
agent-based model called LoveWorld, rebuilt here with no ties back to it.

## License

MIT.
