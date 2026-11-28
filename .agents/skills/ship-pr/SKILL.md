---
name: ship-pr
description: Take an open PR of this repository to merged or parked with the ship loop. Use after you open or update a PR, or when asked to ship, land, or babysit one.
---

# Ship a PR

The loop is a script. It reads the PR state with `gh`, applies the gates in `.github/ship-pr.json`, and prints one next step. You do the step, then tick again. The tiers and the high-tier list are in [decision 0037](../../../docs/decisions/0037-agent-merge-and-automations.md).

1. Pick the risk tier from decision 0037 and write it in the System recap. When two tiers fit, pick the higher one.
2. Tick:

   ```sh
   npx kcd-skills@latest autopilot ship-pr <pr-number> --risk <low|medium|high>
   ```

3. Do the step it prints, then tick again:
   - `fix-ci`, `fix-conflicts`: fix on the branch, run `pnpm verify`, push.
   - `wait`, `wait-for-review`: tick again after the checks or CodeRabbit finish.
   - `address-review`: fix each thread, or reply with the reason it does not apply. Then resolve it with `npx kcd-skills@latest autopilot ship-pr resolve <threadId>`.
   - `ready-to-merge`: for medium, first confirm that the Testing section has control CLI proof (`.agents/skills/control-billy/SKILL.md`). Then tick again with `--merge`.
   - `park`: stop. Tell the repository owner the PR number and the reason.
4. The loop is done at `done` (merged) or `park`. Then file friction (step 5).
5. File each durable papercut from this PR as an issue with the friction form and a `P0` to `P3` label. When there is none, say so in your hand-off.

A change of tier after review starts needs a fresh tick with the new `--risk`.
