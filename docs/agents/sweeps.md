# Sweeps

The army `sweep` kinds for this repository. Each sweep opens at most one PR per run, so the schedule sets the token cost.

Status: planned. The repository owner creates the T3 Code scheduled tasks after this file is on `main`; until then, no sweep runs on its own.

## Scheduled

Each task's prompt is `/sweep <kind>` in this repository, on the repository owner's machine. One sweep a day at most, so runs never overlap.

| Kind | When (Europe/Warsaw) | Billy facts |
| --- | --- | --- |
| friction | Monday and Thursday, 09:00 | Issues with the `friction` label; priorities and `needs-decision` are in [CONTRIBUTING.md](../../CONTRIBUTING.md). |
| docs | Tuesday and Friday, 18:00; skip when `main` had no commits since the last run | Includes `docs/verification`, `docs/primitives/catalog.json`, and `.agents/skills`. |
| tests | Wednesday, 18:00; skip when `main` had no commits since the last run | The agent tests run in `pnpm verify` through `@repo/agent`. |
| cleanup | Saturday, 10:00 | Issues titled `Cleanup:` with a Ready when section. |

Change a schedule here and in T3 Code in the same change.
