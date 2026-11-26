# 0035: Code lists the open items of the Summary

Status: accepted

Date: 2026-11-26

Ticket [#228](https://github.com/kacperborowieckb/billy/issues/228) of [#182](https://github.com/kacperborowieckb/billy/issues/182). The repository owner chose the direction "Code lists open items" on 2026-11-26. It supersedes one rule of [0033](0033-prompt-and-conversation-architecture.md), "Untrusted Content and Stubs": the prompt of the `compaction` task says "name Notes by id". All other rules of 0033 and [0034](0034-architecture-review-changes.md) stay in force.

## Decision

- **The model writes prose with no ids.** The `compaction` prompt tells the model to write no ids. It also tells the model to drop small talk and the detail of finished work.
- **Code writes the open items.** At each Compaction, code reads the open items from storage. These are the Notes with an open Open Loop, the active Schedules, and the open Pending Approvals.
- **One row, two parts.** The Summary row is one user message with two text parts. The first part is the model prose. The second part is the list of open items. The request layout of 0033 does not change.
- **Only code-written fields.** Each line of the list holds an id and fields that code writes. Examples are due times, repeat rules, tool names, and expiry times. The list holds no text of a Note, a Schedule, or a Pending Approval. So it adds no Untrusted Content, and the trust rule of 0033 for the Summary stays true.
- **A fixed maximum.** The list shows at most 10 items of each kind. A line gives the count of the others and names the tool that lists them. A Schedule line names at most 3 of its Open Loops and gives the count of the others.
- **The next Compaction reads only the prose.** The field `earlierSummary` holds the old prose, not the old list. So ids do not grow the Summary from one Compaction to the next.
- **The limit applies to the prose.** `maxSummaryTokens` is the output limit of the model call. Code checks only the model output against it. The size of the list follows the open items, not the number of Compactions.
- **The Profile is not in the list.** The Owner Context Block of each request holds the Profile with its entry ids.

## Why

The retest of [#227](https://github.com/kacperborowieckb/billy/issues/227) showed that the model did not keep to the Summary target. Each Summary added to the one before it. About 8 UUIDs used about a fifth of the text. After about 10 Turns, the output limit cut both attempts, and Compaction stopped. A model cannot count its tokens, but code can write the ids exactly.

## Rejected options

- **Short references instead of UUIDs.** Code must map them back to ids, and the model can still copy old detail.
- **A target in words or lines.** It does not remove the ids, and the model can still miss the target.
- **A stronger rule to drop small talk, alone.** The prompt now has this rule too. But a prompt alone did not keep the Summary small.

## Revisit if

- The model still writes ids in the prose, and the Summary grows over many Compactions.
- An Owner often has more than 10 open items of one kind, and the agent loses track of them.
