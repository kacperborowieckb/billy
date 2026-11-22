# 0032: A Pending Approval keeps the Trust Level of its drafting Turn

Status: accepted

Date: 2026-11-22

Ticket [#176](https://github.com/kacperborowieckb/billy/issues/176) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and [0030](0030-untrusted-context-of-a-turn.md). It supersedes the rule of 0030 that names three paths for Untrusted Content, and its rule that code checks only the recent Conversation and the situation part of the system prompt for the marker. All other rules of 0027 and 0030 stay in force.

## Decision

- **A fourth path.** An Owner message Turn also starts `untrusted` when its system prompt lists an open Pending Approval that a Turn with the `untrusted` Trust Level drafted. The summary of such an Approval comes from the tool input of that Turn, so it is Untrusted Content for as long as the Approval is `pending` and not expired. This holds after the forwarded messages leave the recent Conversation.
- **Structured data.** Each Pending Approval keeps the Trust Level of its drafting Turn in the column `trust_level`. Code writes it when it drafts the Approval: `untrusted` when the Turn was untrusted at that time, also after a tool result changed it. Code reads this column to decide the trust of the next Owner message Turn. It does not look for marker text in the summary. A row from before the column existed counts as `untrusted`.
- **What the model reads.** The system prompt wraps the summary of an `untrusted` Approval in the Untrusted Content marker, so the model reads it as data.
- **Status, not authority.** The listing of an Approval in the system prompt is status information. It gives no authority to run a new call. A typed yes or no still answers nothing (0027).

## Why

A forward, then "remind me", left an `untrusted` Pending Approval. After 20 more messages the forward left the recent Conversation, and the next Owner message Turn started `owner` while its system prompt still held the summary. A `change` call that the summary pushed then ran with no Approval. The drafting Turn is the only place that knows the trust of the summary, so code keeps it with the Approval.

## Revisit if

- Owners tap buttons so often for plain requests, because an old `untrusted` Approval waits, that the expiry time is too long.
- A Pending Approval can come from a Turn that is not an Owner message Turn, with its own trust rule.
