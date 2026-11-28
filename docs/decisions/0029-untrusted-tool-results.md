# 0029: A Turn becomes untrusted after an untrusted tool result

Status: accepted

Partly superseded: [0039](0039-auto-review.md) sends a `change` call of an `untrusted` Turn to a reviewer model, which can allow it with no Approval.

Partly superseded: [0034](0034-architecture-review-changes.md) changes "Which Turns": a Scheduled Task Turn and a Proactive Turn also follow their tool results. The code follows 0034 when [#182](https://github.com/kacperborowieckb/billy/issues/182) ships.

Partly superseded: [0030](0030-untrusted-context-of-a-turn.md) replaces the last "Revisit if" item, which names two ways that Untrusted Content enters an Owner message Turn and that this record does not cover.

Partly superseded: [0036](0036-mcp-connections.md) replaces "The exception of `capture_note`". A new Note that links to no existing Note runs with no Approval in every `untrusted` Turn, and code marks it `untrusted`.

Partly superseded: [0038](0038-conversation-tool-history.md) adds that a later Turn can start `untrusted` from the stored Conversation.

Date: 2026-11-21

Ticket [#146](https://github.com/kacperborowieckb/billy/issues/146) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and adds rules that 0027 does not give. All rules of 0027 and [0028](0028-approval-requests-in-telegram.md) stay in force.

## Decision

- **Which result is untrusted.** A tool result returns Untrusted Content when a string in it has the opening Untrusted Content marker. Code adds that marker only from the stored Trust Level of the data (`textForModel`, `markUntrustedContent`), and every tool that returns the text of an untrusted Note adds it. So the rule covers every tool, also a later one, with no list of tool names. The model cannot remove a marker. A marker that the Owner types into an own Note makes the Turn `untrusted`, which asks for more Approval and never less.
- **When the Trust Level changes.** The Model Gateway reads the results of each model step when the step ends, before the next step starts. The gate reads the current Trust Level for each call. The AI SDK decides all calls of a step before it runs them, so a call in the same step as the untrusted result runs with the Trust Level from before that step.
- **After a reset or a Restart.** The Turn keeps its Turn Event id, and its recorded tool results come back from Turn progress. When one of them returns Untrusted Content, the Turn starts `untrusted`.
- **Which Turns.** Only an Owner message Turn follows its tool results, because only it can ask the Owner for Approval (0027, Scope). Proactive Turns and Scheduled Task Turns stay `owner`.
- **The exception of `capture_note`.** The exception of 0027 and 0028 holds only when the Burst is `untrusted`, because only then does code mark the new Note `untrusted`. In a Turn that becomes `untrusted` after a tool result, the Burst is the Owner's own words, so the new Note would be an `owner` Note. Its text can copy the Untrusted Content, so `capture_note` needs Approval in that Turn.
- **Trace.** The Trace of the Turn records the change in `trustLevelChange`: the new Trust Level and the id and name of the tool call whose result changed it. A Turn that starts `untrusted` from its Burst records no change.

## Why

The opening marker is the one place where code turns the stored Trust Level into text for the model. A check of that marker cannot forget a tool, and a list of tools or a flag on each tool can. Reading the results at the end of a step follows the order in which the AI SDK decides and runs calls.

## Revisit if

- A tool returns Untrusted Content without the marker, for example the output of an MCP Connection.
- Proactive Turns or Scheduled Task Turns can ask the Owner for Approval.
- Untrusted Content enters an Owner message Turn in a way other than its Burst or its own tool results. Today two ways exist, and this decision does not cover them: the Open Loops of a connected Proactive Message in the system prompt, and the tool results of earlier Turns in the Conversation.
