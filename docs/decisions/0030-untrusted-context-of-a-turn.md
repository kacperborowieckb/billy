# 0030: Untrusted Content in the context of a Turn makes the Turn untrusted

Status: accepted

Date: 2026-11-22

Ticket [#167](https://github.com/kacperborowieckb/billy/issues/167) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and [0029](0029-untrusted-tool-results.md). It supersedes the last "Revisit if" item of 0029, which names two ways that Untrusted Content enters an Owner message Turn and that 0029 does not cover. All other rules of 0027, 0028, and 0029 stay in force.

## Decision

- **The strict rule.** An Owner message Turn starts `untrusted` when Untrusted Content reaches it by any of three paths, besides its own Burst:
  - The Open Loops of a connected Proactive Message in the system prompt. For an `untrusted` Note, that text is Untrusted Content.
  - The tool results of earlier Turns in the Conversation.
  - The forwarded messages of earlier Bursts in the Conversation.
- **How code checks it.** Code looks for the opening Untrusted Content marker in the recent Conversation that the model reads and in the situation part of the system prompt. This is the same check as for a tool result in 0029. The Turn follows the context that the model sees: when the marker leaves the recent Conversation, the Turn can start `owner` again.
- **Which Turns.** Only an Owner message Turn, as in 0029. Proactive Turns and Scheduled Task Turns stay `owner`.
- **Trace.** The Trace records no `trustLevelChange` for such a Turn, as for a Turn that starts `untrusted` from its Burst.
- **Open Pending Approvals in the prompt.** The system prompt of an Owner message Turn lists the Pending Approvals that are `pending` and not expired. The model then drafts no duplicate, and it tells the Owner to tap the buttons. A typed yes or no never answers an Approval (0027).

## Why

A forward, then "remind me", then a typed "yes" ran `set_schedule` with no Approval, while the first Pending Approval stayed pending. The second Turn was in the Owner's own words, but the forwarded text was still in its Conversation. A rule that follows only the Burst and the tool results of the Turn cannot see that text. A check of the whole context that the model reads closes every path with one rule. The cost is that a Turn can ask for Approval more often, never less. Assistant text that quotes a marker has the same effect, and this is accepted.

## Revisit if

- Asking for Approval so often makes the Owner tap buttons for plain requests that follow an old forward.
- A way exists to show the model Untrusted Content that the Conversation and the system prompt do not hold.
- Proactive Turns or Scheduled Task Turns can ask the Owner for Approval.
