# 0028: Approval requests in Telegram

Status: accepted

Date: 2026-11-21

Ticket [#147](https://github.com/kacperborowieckb/billy/issues/147) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and adds rules that 0027 does not give. All rules of 0027 stay in force.

## Decision

- **The exception of `capture_note`.** A tool declares the exception to Approval in an `untrusted` Turn with a check of its decoded input (`marksItsWorkUntrusted`). So the gate has no tool names. A tool may declare it only for an input whose every write is a new item that code marks `untrusted`. `capture_note` declares it only when the call links no existing Note: a link changes the existing Note too, so a `capture_note` call with `linkedNoteIds` needs Approval.
- **Approval messages.** The Delivery of a Turn with drafts sends the model's reply text first. Then it sends the Approval rows in Approval messages that have only the summaries and the Approve and Reject buttons. One Approval message holds as many rows as fit in the Telegram text limit (4,096 characters), and the numbering of the rows continues across the messages. Each Pending Approval stores the Channel message id of the Approval message that shows its row, so the later tickets can edit that message alone. A summary is never cut to make room; only a summary longer than 3,500 characters is cut, so that one row always fits in one message.
- **Opening drafts.** After the send, code makes `pending` only the drafts that the sent Approval messages show. Another draft of the same Turn Event, for example from an answer that a Restart dropped, stays `draft`.
- **A model failure after drafting.** When the model fails or reaches the step limit after code wrote drafts in the Turn, the Turn still sends the Approval messages, with no model text, so that no draft is lost. The Approval messages are code-written, so the Owner sees exactly what waits.
- **Summaries.** A summary names every target of the call: the Notes that the call links, unlinks, closes, or follows up, by their stored text, and the Schedule that the call changes or cancels, by its Action. A summary of a local due time that does not exist says so.

## Why

The decision 0027 gives one Delivery with one row for each draft, but does not say how the rows fit the Telegram limit. A cut summary or a limit on Approvals for each Turn would hide part of a call or refuse a call that the Owner asked for. Several Approval messages keep every summary whole. A link from a new untrusted Note changes an existing Note, so the exception of 0027 cannot cover it.

## Revisit if

- The Channel is not Telegram, or Telegram changes its text limit.
- A tool other than `capture_note` needs the exception.
