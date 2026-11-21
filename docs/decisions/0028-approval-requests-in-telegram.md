# 0028: Approval requests in Telegram

Status: accepted

Date: 2026-11-21

Ticket [#147](https://github.com/kacperborowieckb/billy/issues/147) of spec [#139](https://github.com/kacperborowieckb/billy/issues/139). It builds on [0027](0027-actions-and-approval.md) and adds rules that 0027 does not give. All rules of 0027 stay in force.

## Decision

- **The exception of `capture_note`.** A tool declares the exception to Approval in an `untrusted` Turn with a check of its decoded input (`marksItsWorkUntrusted`). So the gate has no tool names. A tool may declare it only for an input whose every write is a new item that code marks `untrusted`. `capture_note` declares it only when the call links no existing Note: a link changes the existing Note too, so a `capture_note` call with `linkedNoteIds` needs Approval.
- **Approval messages.** The Delivery of a Turn with drafts sends the model's reply text first. Then it sends the Approval rows in Approval messages that have only the summaries and the Approve and Reject buttons. One Approval message holds as many rows as fit in the Telegram text limit (4,096 UTF-16 code units), and the numbering of the rows continues across the messages. Each Pending Approval stores the Channel message id of the Approval message that shows its row, so the later tickets can edit that message alone.
- **Summary length.** Code never cuts a summary. A call whose summary is longer than 3,500 UTF-16 code units gets no Pending Approval, and the model gets a refusal, so one row always fits in one message.
- **Quotes.** Code quotes each text in a summary as a JSON string. A quote or a line break in a text, for example in forwarded content, cannot end its quote and make a summary say something else.
- **Opening drafts.** After the send, code makes `pending` only the drafts that the sent Approval messages show. Another draft of the same Turn Event, for example from an answer that a Restart dropped, stays `draft`. When Telegram refuses a later Approval message, the Delivery is `SendFailed`, and code opens no draft. Decision 0027 says that a failed send deletes the drafts; ticket [#145](https://github.com/kacperborowieckb/billy/issues/145) does that and settles the buttons that the Owner already sees.
- **Summaries.** A summary writes the frozen input in plain words. It names the Notes and the Schedules of the call by their stored text when code can read them, and by their id when it cannot. The summary of `capture_note` shows the text that the call keeps: for a forwarded message, the forwarded text, not the model text.

## Why

The decision 0027 gives one Delivery with one row for each draft, but does not say how the rows fit the Telegram limit. A cut summary would hide part of a call. Several Approval messages keep every summary whole. A link from a new untrusted Note changes an existing Note, so the exception of 0027 cannot cover it. Forwarded text is Untrusted Content, so it must not be able to change what a summary says.

A summary does not repeat every check of its tool. When the Owner approves a call that the tool then refuses, the Approval message shows "Approved, but it failed" with the reason (#144). Issue [#164](https://github.com/kacperborowieckb/billy/issues/164) tracks summaries that do not match the execution in narrow cases.

## Revisit if

- The Channel is not Telegram, or Telegram changes its text limit.
- A tool other than `capture_note` needs the exception.
- Owners approve calls that then fail often enough to need checks before a draft (#164).
