# Automations

T3 Code scheduled tasks run these prompts on the repository owner's machine ([decision 0037](decisions/0037-agent-merge-and-automations.md)). Each run starts on a new branch from `origin/main` and opens at most one PR. A run with nothing to do opens no PR and says so. Each PR goes through the ship loop (`.agents/skills/ship-pr/SKILL.md`) like any other change.

Every run works the highest priority first (`P0`, then `P1`, `P2`, `P3`). It skips issues with `needs-decision`. This file is the source of truth for the prompts. Update the scheduled task in T3 Code in the same PR that changes a prompt here.

Errors to issues waits for a production Instance (#190).

## Friction sweep

When: daily, 09:00 Europe/Warsaw.

```text
In the billy repository, list open issues with the friction label and no needs-decision label. Pick the one with the highest priority label (P0 first); when two have the same priority, pick the oldest. Reproduce it. When it is already fixed or does not reproduce, close it with a note that names the evidence. Otherwise fix it on a new branch from origin/main, run pnpm verify, open one PR that closes the issue, and ship it with the ship-pr skill. Do one issue per run.
```

## Docs freshness

When: daily, 18:00 Europe/Warsaw. Skip when `main` had no commits in the last 24 hours.

```text
In the billy repository, read the commits on main from the last 24 hours. Find statements in AGENTS.md, CONTRIBUTING.md, README.md, docs/verification, docs/primitives/catalog.json, and .agents/skills that those commits made wrong. Fix only those statements, on a new branch from origin/main. Do not edit decision records: open a needs-decision issue when one looks stale. Run pnpm verify, open one PR at risk low, and ship it with the ship-pr skill. When nothing is stale, open no PR.
```

## Test pruning

When: daily, 19:00 Europe/Warsaw. Skip when `main` had no commits in the last 24 hours.

```text
In the billy repository, look at the tests that the commits on main from the last 24 hours added or changed. Find tests that repeat another test's behavior, test implementation details instead of behavior, or failed and passed on the same commit in CI in the last 7 days. Remove or merge them only when the behavior stays covered; name the test that still covers it in the PR. Run pnpm verify, open one PR at risk low, and ship it with the ship-pr skill. When nothing qualifies, open no PR.
```

## Legacy reaper

When: weekly, Monday 10:00 Europe/Warsaw.

```text
In the billy repository, list open issues whose title starts with "Cleanup:" and that have no needs-decision label, highest priority first. For each one, check its Ready when condition against main. Take the first one whose condition holds, do the cleanup on a new branch from origin/main, run pnpm verify, open one PR that closes the issue, and ship it with the ship-pr skill. When no condition holds, open no PR.
```
