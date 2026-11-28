---
name: control-billy
description: Prove a change in the running Billy agent with the control CLI. Use before you claim app behavior works, when you write the Testing section of a PR, or when the ship loop asks for medium-tier proof.
---

# Control Billy

Use the control CLI for every check of the running agent. It starts the real Worker locally with temporary storage, a fake Telegram API, and a fake model, so local proof sends no messages and spends no money.

Run it from `apps/agent` with `pnpm control <command>`, or from the root with `pnpm --filter @repo/agent control <command>`. `pnpm control --help` lists the commands. The [control CLI guide](../../../docs/verification/agent.md#control-cli) has the flags and the prefixes that make the fake model call each tool (`keep:`, `recall:`, `remind:`, `todo:`, `mcp:`, and more).

## Proof

1. Add or update the test that covers the change. Run `pnpm verify`.
2. `pnpm control doctor`.
3. Drive the change with the fake model prefix for the tool it touches, and assert on the reply:

   ```sh
   pnpm control request --message "keep: buy a gift for Ana before Friday" --contains "Kept note"
   ```

4. Route change: `pnpm control map`, then commit the Feature Map. `pnpm verify` runs `map --check`.
5. Paste each command and its result line into the Testing section of the PR.

A change that the fake model cannot reach needs a new prefix in the fakes under `apps/agent/control`. Add it in the same PR, and add it to the guide.

## Protected commands

These need the repository owner's approval first ([decision 0037](../../../docs/decisions/0037-agent-merge-and-automations.md)):

- `pnpm control eval`: real model calls cost money.
- `pnpm control owner add --url <deployed Instance>`: it changes production data.
