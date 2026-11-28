---
name: control-billy
description: How to observe a change in the running Billy agent. Use when you prove app behavior in apps/agent, or when the merge policy asks for control CLI proof.
---

# Control Billy

`prove-it` says to observe the real thing. In Billy the real thing is the Worker, and `pnpm control` (in `apps/agent`) is how you reach it. `request` runs the real Worker with temporary storage, a fake Telegram API, and a fake model, so proof sends no messages, spends no money, and leaves no trace. `pnpm control --help` lists the commands; the [control CLI guide](../../../docs/verification/agent.md#control-cli) has the flags and the message prefixes that make the fake model call each tool.

## Principles

- **Drive the path you changed, and assert on its outcome.** Pick the prefix that makes the fake model call the tool you touched. Assert on the outcome that the change produces: the reply text with `--contains`, or, for silence and reactions, the line that `request` prints (`No Telegram send for the message ...`, `Telegram setMessageReaction ...`). A result that only proves the Worker started proves nothing about your change.
- **Know what the fake cannot show.** The fake model always follows the script. How the real model chooses tools is an Eval Case (`pnpm control eval`), which costs money and needs the owner's approval. Name that gap in the PR when it matters.
- **Extend the harness with the change.** `request` reaches the agent through the Telegram webhook only. When your change sits behind another route, or no prefix reaches it, extend `pnpm control` in `apps/agent/control` to send that request and check its result, and update the guide in the same PR. Proof that needs a manual step is proof the next agent skips.
- **Routes change the map.** After a route change, run `pnpm control map` and commit the Feature Map; `pnpm verify` fails on drift.
- **Production stays the owner's.** `owner add --url` with a deployed Instance and `eval` are protected actions ([decision 0037](../../../docs/decisions/0037-agent-merge-and-automations.md)).

Example: `pnpm control request --message "keep: buy a gift for Ana before Friday" --contains "Kept note"`.
