# Merge policy

The repository owner's standing decision on who merges ([decision 0037](../decisions/0037-agent-merge-and-automations.md)). The general rules for using it are in army's `merge-policy` reference.

## Tiers

| Tier | What puts a change here | Gates | Who merges |
| --- | --- | --- | --- |
| Low | Docs, tests, and refactors with no behavior change | `Verify` passes | Agent |
| Medium | A behavior change outside the high list | `Verify` passes, CodeRabbit reviewed with no open threads, control CLI proof in Testing (`.agents/skills/control-billy/SKILL.md`) | Agent |
| High | Anything on the high list | All medium gates | Repository owner |

**High list:** auth and permissions, Owner proof, Approval, and Trust Level code; data migrations and destructive data changes; spending and billing; deploys, releases, and public publishing; `.github/workflows`, `.github/ship-pr.json`, rulesets, and secrets; decision records and this file.

Write the tier in the `Risk:` line of the PR template.

## Gate tool

```sh
npx kcd-skills@1.7.0 autopilot ship-pr <pr> --risk <low|medium|high>
```

It reads [`.github/ship-pr.json`](../../.github/ship-pr.json). Add `--merge` when it prints `ready-to-merge`. Upgrade the pinned version only in its own PR, which is high tier.

## After merge

No post-merge check yet: no production Instance exists (#190). Add a running-version check here when one does.
