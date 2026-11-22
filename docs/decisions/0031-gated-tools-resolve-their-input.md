# 0031: A gated tool resolves its input once, for its summary and its execution

Status: accepted

Date: 2026-11-22

Ticket [#164](https://github.com/kacperborowieckb/billy/issues/164) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and [0028](0028-approval-requests-in-telegram.md). It supersedes one rule of 0027: the list of `read` tools under "Risk Class". All other rules of 0027 and 0028 stay in force.

## Decision

- **One resolve function.** Each tool that can need Approval gives one function that checks its input, reads the Notes, Schedules, or Profile entries that it targets, and returns the resolved target or a refusal. The summary of the Approval and the execution of the tool both start from that target. A summary cannot drift from what runs.
- **A refusal before a draft.** When the resolve function refuses a call, code drafts no Pending Approval, and the model gets the refusal as the result of the call. The write of the tool still checks the same rules inside its transaction, because state can change between the draft and the Approval.
- **A failed read refuses.** When a read in the resolve step fails, the call is refused with the failure message of the tool. The summary no longer falls back to an id.
- **Risk Class of two preference tools.** `quiet_hours` and `proactive_message_budget` declare `read`. Their input function raises the class to `change` when the input gives a value to change. A call with no input only reads, so it needs no Approval in an `untrusted` Turn. A call with only a start or an end of Quiet Hours is `change` and the resolve function refuses it.
- **The list of 0027.** `read` is now `search_notes`, `list_linked_notes`, `list_open_loops`, `list_schedules`, the outcome tools, and, for a call with no value to change, `quiet_hours` and `proactive_message_budget`. `change` stays for every other tool.

## Why

Review of #163 found many cases where a summary did not match the execution, or where the Owner got an Approval for a call that the tool then refused. One function for both removes the whole class of drift. Reading Owner data in the resolve step lets the summary name the target.

## Revisit if

- A resolve step becomes slow enough to delay the reply that carries the Approval.
- A tool needs a check that only its write can make.
