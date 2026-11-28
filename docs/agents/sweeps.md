# Sweeps

The army `sweep` kinds for this repository. Each sweep opens at most one PR per run, so the schedule sets the token cost.

Status: active. Four T3 Code scheduled tasks (`Billy sweep: <kind>`) run these sweeps. T3 runs on UTC, so the Warsaw time is one hour later in winter and two hours later in summer.

## Scheduled

Each task's prompt is `/sweep <kind>` in this repository, on the repository owner's machine. One sweep a day at most, so runs never overlap.

| Kind | When (UTC) | Billy facts |
| --- | --- | --- |
| friction | Monday and Thursday, 08:00 | Issues with the `friction` label; priorities and `needs-decision` are in [CONTRIBUTING.md](../../CONTRIBUTING.md). |
| docs | Tuesday and Friday, 17:00; skip when `main` had no commits since the last run | Includes `docs/verification`, `docs/primitives/catalog.json`, and `.agents/skills`. |
| tests | Wednesday, 17:00; skip when `main` had no commits since the last run | The agent tests run in `pnpm verify` through `@repo/agent`. |
| cleanup | Saturday, 09:00 | Issues titled `Cleanup:` with a Ready when section. |

Change a schedule here and in T3 Code in the same change.
