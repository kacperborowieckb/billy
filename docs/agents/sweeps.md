# Sweeps

The army `sweep` kinds that run in this repository, as T3 Code scheduled tasks on the repository owner's machine. Each task's prompt is `/sweep <kind>` in this repository.

| Kind | When (Europe/Warsaw) | Billy facts |
| --- | --- | --- |
| friction | Daily, 09:00 | Issues with the `friction` label; priorities and `needs-decision` are in [CONTRIBUTING.md](../../CONTRIBUTING.md). |
| docs | Daily, 18:00, when `main` had commits in the last 24 hours | Includes `docs/verification`, `docs/primitives/catalog.json`, and `.agents/skills`. |
| tests | Daily, 19:00, when `main` had commits in the last 24 hours | The agent tests run in `pnpm verify` through the `@repo/agent` workspace. |
| cleanup | Weekly, Monday 10:00 | Issues titled `Cleanup:` with a Ready when section. |

Change a schedule here and in T3 Code in the same change.
