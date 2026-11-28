# 0037: Agent merge, ship loop, and scheduled agents

Status: accepted

Date: 2026-11-28

Supersedes [0002](0002-agent-authority.md).

## Decision

Agents ship most changes. The repository owner owns product decisions and the high risk tier.

- **Merge.** Agents merge low and medium risk PRs when the gate tool passes. The repository owner merges high risk PRs. The [merge policy](../agents/merge-policy.md) holds the tiers, the gates, and the high list.
- **Workflow.** Delivery follows the owner's army skills (`to-pr`, `orchestrate`, `prove-it`). This repository holds only its own facts in `docs/agents/`.
- **Scheduled agents.** T3 Code scheduled tasks run the [sweeps](../agents/sweeps.md). Each sweep delivers at most one PR per run, under the same merge policy.
- **Protected actions.** Agents get explicit repository owner approval before public publishing or releases, auth or permission changes on a live service, destructive data changes, spending (for example real model calls), and external messages. An explicit instruction authorizes the named action only. Agents never expose secrets or bypass checks.
- **Not used.** Kody and its factory board. GitHub issues and labels stay the home for work.

## Why

The repository has real checks and review evidence now. `Verify` and CodeRabbit ran on every one of the last 10 merged PRs, and the owner merged each one with green checks. The owner spends review time on changes that a passing check already proves. The tiers keep the owner on the changes that are hard to undo.

## Revisit if

- An agent-merged PR causes a regression that a human review would have caught. Then move that kind of change to the high tier.
- 20 medium PRs merge with no regression. Then consider other gates for medium.
- A production Instance exists (#190). Then add flags, a rollback runbook, and a post-merge check to the merge policy.
