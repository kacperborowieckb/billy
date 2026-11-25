import type { ModelMessage } from "ai";
import { Effect } from "effect";

import { PendingApprovals } from "../approval/pending-approvals.ts";
import { Journal } from "../journal/journal.ts";
import type { JournalEntry } from "../journal/journal.ts";
import { burstInputs, newestEventOf } from "./burst.ts";
import type { Burst } from "./burst.ts";
import { sendReaction } from "./delivery-reaction.ts";
import {
  deliveryStateOfEntries,
  fail,
  honestFailureText,
  recordUnconfirmedSend,
  sendFailureNotice,
  unconfirmedSendReason,
} from "./delivery.ts";
import type { DeliveryState } from "./delivery.ts";
import { inputMessageOf } from "./event-message.ts";
import { Inbox } from "./inbox.ts";
import type { InboxEvent } from "./inbox.ts";
import { reacted, replied, silent, unanswered } from "./stored-turn.ts";
import type { TurnEnding } from "./stored-turn.ts";
import { TurnProgress } from "./turn-progress.ts";
import { mainConversation } from "./turn-session.ts";
import type { TurnSession } from "./turn-session.ts";

const endingOf = (state: DeliveryState): TurnEnding => {
  switch (state._tag) {
    case "Sent": {
      if (state.reaction !== undefined) {
        return reacted;
      }
      return state.text === undefined ? unanswered : replied(state.text);
    }
    case "ReactionUnconfirmed": {
      return reacted;
    }
    case "Silent": {
      return silent;
    }
    default: {
      return unanswered;
    }
  }
};

const recordConversation = Effect.fnUntraced(function* recordConversation(
  event: InboxEvent,
  state: DeliveryState,
  { session, inputs }: RecoveredTurn
) {
  const progress = yield* TurnProgress;
  yield* session.commit({
    eventId: event.eventId,
    turnContext: yield* progress.turnContextFor(event.eventId),
    inputs: inputs ?? [yield* inputMessageOf(event)],
    steps: yield* progress.completedFor(event.eventId),
    ending: endingOf(state),
  });
});

interface SkippedScheduledTask {
  readonly dailyTokenBudget: number;
  readonly tokensSpent: number;
}

interface RecoveredTurn {
  readonly session: TurnSession;
  readonly inputs?: readonly ModelMessage[];
}

export interface Recovery<
  UnsentRequirements,
  NoticeRequirements,
> extends RecoveredTurn {
  readonly resumeUnsent: (
    skipped: SkippedScheduledTask | undefined
  ) => Effect.Effect<"settled" | "unanswered", unknown, UnsentRequirements>;
  readonly failureNoticeText: Effect.Effect<
    string | undefined,
    unknown,
    NoticeRequirements
  >;
  readonly replyTo?: InboxEvent;
}

export const ownerMessageRecovery = (burst: Burst) => ({
  resumeUnsent: () => Effect.succeed("unanswered" as const),
  failureNoticeText: Effect.succeed(honestFailureText),
  session: mainConversation,
  inputs: burstInputs(burst),
  replyTo: newestEventOf(burst),
});

interface Settling<UnsentRequirements, NoticeRequirements> {
  readonly event: InboxEvent;
  readonly entries: readonly JournalEntry[];
  readonly state: DeliveryState;
  readonly recovery: Recovery<UnsentRequirements, NoticeRequirements>;
}

const skippedPointOf = (entries: readonly JournalEntry[]) => {
  const skipped = entries.find(
    (entry) => entry.record._tag === "ScheduledTaskSkipped"
  );
  return skipped?.record._tag === "ScheduledTaskSkipped"
    ? skipped.record
    : undefined;
};

const settleState = Effect.fnUntraced(function* settleState<
  UnsentRequirements,
  NoticeRequirements,
>({
  event,
  entries,
  state,
  recovery,
}: Settling<UnsentRequirements, NoticeRequirements>) {
  const inbox = yield* Inbox;

  switch (state._tag) {
    case "Unsent": {
      return yield* recovery.resumeUnsent(skippedPointOf(entries));
    }
    case "Sent":
    case "Silent": {
      yield* inbox.markDone([event]);
      return "settled" as const;
    }
    case "SendFailed": {
      yield* fail(event, state.reason);
      return "settled" as const;
    }
    case "ReactionUnconfirmed": {
      const delivery = yield* sendReaction(event, state.reaction);
      yield* delivery._tag === "Failed"
        ? fail(event, delivery.reason)
        : inbox.markDone([event]);
      return "settled" as const;
    }
    case "Unconfirmed": {
      yield* recordUnconfirmedSend(event);
      yield* fail(event, unconfirmedSendReason);
      return "settled" as const;
    }
    case "FailedNoticePending": {
      const noticeText = yield* recovery.failureNoticeText;
      yield* noticeText === undefined
        ? inbox.markFailed([event])
        : sendFailureNotice({
            event,
            session: recovery.session,
            text: noticeText,
            replyTo: recovery.replyTo,
          });
      return "settled" as const;
    }
    case "FailedNoticeSent": {
      yield* recovery.session.rememberFailureNotice(event.eventId, state.text);
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    case "SendFailureRecorded":
    case "FailedNoticeRefused": {
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    case "FailedNoticeUnconfirmed": {
      yield* recordUnconfirmedSend(event);
      yield* inbox.markFailed([event]);
      return "settled" as const;
    }
    default: {
      return state satisfies never;
    }
  }
});

const settleDrafts = Effect.fnUntraced(function* settleDrafts(
  event: InboxEvent,
  state: DeliveryState
) {
  const pendingApprovals = yield* PendingApprovals;
  yield* state._tag === "Unconfirmed"
    ? pendingApprovals.openUnconfirmedDrafts(event.eventId)
    : pendingApprovals.dropDrafts(event.eventId);
});

export const settleFromJournal = Effect.fnUntraced(function* settleFromJournal<
  UnsentRequirements,
  NoticeRequirements,
>(
  event: InboxEvent,
  recovery: Recovery<UnsentRequirements, NoticeRequirements>
) {
  const journal = yield* Journal;
  const entries = yield* journal.readForEvent(event.eventId);
  const state = deliveryStateOfEntries(entries);

  yield* settleDrafts(event, state);
  if (state._tag !== "Unsent") {
    yield* recordConversation(event, state, recovery);
  }
  return yield* settleState({ event, entries, state, recovery });
});
