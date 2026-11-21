import { DateTime, Effect, Option } from "effect";

import {
  approvalsDueToExpire,
  expireApproval,
} from "../approval/approval-expiry.ts";
import {
  conversationEntryOf,
  expiredStatus,
} from "../approval/approval-status.ts";
import type { PendingApproval } from "../approval/pending-approvals.ts";
import { AgentStorage } from "./agent-storage.ts";
import { editApprovalMessage } from "./approval-message-edit.ts";
import { Conversation } from "./conversation.ts";
import { Inbox } from "./inbox.ts";
import { OwnerChannelConversation } from "./owner-channel-conversation.ts";

const oneApprovalOfEachMessage = (due: readonly PendingApproval[]) => [
  ...new Map(
    due.flatMap((approval) =>
      approval.channelMessageId === null
        ? []
        : [[approval.channelMessageId, approval] as const]
    )
  ).values(),
];

const conversationIdOfTurn = Effect.fnUntraced(function* conversationIdOfTurn(
  turnEventId: string
) {
  const inbox = yield* Inbox;
  const ownerChannelConversation = yield* OwnerChannelConversation;
  const [turnEvent] = yield* inbox.ownerMessagesWithIds([turnEventId]);
  if (turnEvent !== undefined) {
    return Option.some(turnEvent.conversationId);
  }
  return Option.fromNullishOr(
    (yield* ownerChannelConversation.current)?.conversationId
  );
});

const showExpired = Effect.fnUntraced(function* showExpired(
  approval: PendingApproval
) {
  const conversationId = yield* conversationIdOfTurn(approval.turnEventId);
  if (Option.isNone(conversationId)) {
    yield* Effect.logWarning("The expired Approval message has no chat", {
      pendingApprovalId: approval.pendingApprovalId,
    });
    return;
  }
  yield* editApprovalMessage({
    conversationId: conversationId.value,
    pendingApprovalId: approval.pendingApprovalId,
  });
});

const expireWithConversationEntry = Effect.fnUntraced(
  function* expireWithConversationEntry(
    approval: PendingApproval,
    now: DateTime.Utc
  ) {
    const { database } = yield* AgentStorage;
    const conversation = yield* Conversation;
    if (yield* expireApproval(database, approval, now)) {
      yield* conversation.append(approval.pendingApprovalId, [
        {
          role: "assistant",
          content: conversationEntryOf(approval.summary, expiredStatus),
        },
      ]);
    }
  }
);

export const expireDueApprovals = Effect.gen(
  function* expireDueApprovalsEffect() {
    const { database } = yield* AgentStorage;
    const now = yield* DateTime.now;
    const due = yield* approvalsDueToExpire(database, now);
    if (due.length === 0) {
      return;
    }
    yield* Effect.forEach(oneApprovalOfEachMessage(due), showExpired, {
      discard: true,
    });
    yield* database.transaction(() =>
      Effect.forEach(
        due,
        (approval) => expireWithConversationEntry(approval, now),
        { discard: true }
      )
    );
  }
);
