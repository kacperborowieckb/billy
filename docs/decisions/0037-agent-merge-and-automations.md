# 0037: Agent merge, ship loop, and scheduled agents

Status: accepted

Date: 2026-11-28

Supersedes [0002](0002-agent-authority.md).

## Decision

Agents ship most changes. The repository owner owns product decisions and the high risk tier.

- **Ship loop.** An agent takes each PR it opens through the ship loop (`.agents/skills/ship-pr/SKILL.md`) until the PR is merged or parked. The loop reads its gates from `.github/ship-pr.json`.
- **Risk tiers.** The PR author sets the tier in the PR template.
  - Low: docs, tests, and internal refactors with no behavior change. Needs a passing `Verify` check. The agent merges.
  - Medium: a behavior change. Needs a passing `Verify` check, a CodeRabbit review with no open threads, and control CLI proof in the Testing section. The agent merges.
  - High: the agent never merges. The repository owner approves or merges.
- **High tier.** A PR is high when it changes any of these: auth and permissions, Owner proof, Approval, or Trust Level code; data migrations or destructive data changes; spending or billing; deploys, releases, or public publishing; `.github/workflows`, rulesets, or secrets; decision records.
- **Scheduled agents.** T3 Code scheduled tasks run the prompts in [automations](../automations.md). Each one opens PRs through the ship loop, highest priority first.
- **Protected actions.** Agents get explicit repository owner approval before public publishing or releases, auth or permission changes on a live service, destructive data changes, spending (for example real model calls), and external messages. An explicit instruction authorizes the named action only. Agents never expose secrets or bypass checks.
- **Not used.** Kody and its factory board. GitHub issues and labels stay the home for work.

## Why

The repository has real checks and review evidence now. `Verify` and CodeRabbit ran on every one of the last 10 merged PRs, and the owner merged each one with green checks. The owner spends review time on changes that a passing check already proves. The tiers keep the owner on the changes that are hard to undo.

## Revisit if

- An agent-merged PR causes a regression that a human review would have caught. Then move that kind of change to the high tier.
- 20 medium PRs merge with no regression. Then consider other gates for medium.
- A production Instance exists (#190). Then add flags, a rollback runbook, and a deploy check to the ship loop.
