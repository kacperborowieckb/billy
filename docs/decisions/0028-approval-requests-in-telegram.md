# 0028: Approval requests in Telegram

Status: accepted

Date: 2026-11-21

Ticket [#147](https://github.com/kacperborowieckb/billy/issues/147) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and adds rules that 0027 does not give. All rules of 0027 stay in force.

## Decision

- **The exception of `capture_note`.** A tool declares the exception to Approval in an `untrusted` Turn with a check of its decoded input (`marksItsWorkUntrusted`). So the gate has no tool names. A tool may declare it only for an input whose every write is a new item that code marks `untrusted`. `capture_note` declares it only when the call links no existing Note: a link changes the existing Note too, so a `capture_note` call with `linkedNoteIds` needs Approval.
- **Approval messages.** The Delivery of a Turn with drafts sends the model's reply text first. Then it sends the Approval rows in Approval messages that have only the summaries and the Approve and Reject buttons. One Approval message holds as many rows as fit in the Telegram text limit (4,096 characters), and the numbering of the rows continues across the messages. Each Pending Approval stores the Channel message id of the Approval message that shows its row, so the later tickets can edit that message alone. Code never cuts a summary. A call whose summary is longer than 3,500 UTF-16 code units (the unit of the Telegram text limit) gets no Pending Approval, and the model gets a refusal, so one row always fits in one message.
- **Opening drafts.** After the send, code makes `pending` only the drafts that the sent Approval messages show. Another draft of the same Turn Event, for example from an answer that a Restart dropped, stays `draft`. When Telegram refuses a later Approval message, the Delivery is `SendFailed`, and code opens no draft, also for the earlier Approval messages that Telegram showed. Decision 0027 says that a failed send deletes the drafts; ticket [#145](https://github.com/kacperborowieckb/billy/issues/145) does that and settles the buttons that the Owner already sees.
- **A model failure after drafting.** When the model fails or reaches the step limit after code wrote drafts in the Turn, the Turn still sends the Approval messages, with no model text, so that no draft is lost. The Approval messages are code-written, so the Owner sees exactly what waits. The Trace of the Turn keeps the reason why the model stopped.
- **Checks before a draft.** The summary function of a tool runs the checks of the tool that write nothing, with the same refusal messages: for example the targets exist (an active Schedule, a Note, an open Open Loop), the time zone of the Owner is known, the due time is real and in the future, and the input is complete. When a check fails, code writes no draft, and the model gets the refusal of the tool, as if the call ran. So the Owner never gets an Approval for a call that the tool would refuse at once. A check that only a write can make (for example a limit of Scheduled Tasks) stays in the execution; after Approve, the Approval message shows "Approved, but it failed" with the reason (#144).
- **Summaries.** A summary names every target of the call: the Notes that the call keeps, links, unlinks, closes, mutes, or follows up, by their stored text and their id, a Profile entry by its kind, text, and id, and the Schedule that the call changes or cancels, by its Action, its next due time, and its id, because two Schedules can have the same Action and due time. Code quotes texts exactly, as a JSON string, so a quote or a line break in a text cannot end its quote and make two calls look the same. It finds the targets as the tool does: `capture_note` shows the text that it keeps (the forwarded text for a forwarded message) and says that nothing changes when the Turn already kept that text, `mute_proactive_message` uses the same function as its execution, `set_schedule` says when the call sets a follow-up of the agent, and `set_time_zone` and the Quiet Hours tool say which Schedules they move (repeating Schedules and the daily Brief). A local due time in a daylight saving gap of the Owner's time zone shows the time when it is really due.

## Why

The decision 0027 gives one Delivery with one row for each draft, but does not say how the rows fit the Telegram limit. A cut summary or a limit on Approvals for each Turn would hide part of a call or refuse a call that the Owner asked for. Several Approval messages keep every summary whole. A link from a new untrusted Note changes an existing Note, so the exception of 0027 cannot cover it.

## Revisit if

- The Channel is not Telegram, or Telegram changes its text limit.
- A tool other than `capture_note` needs the exception.
