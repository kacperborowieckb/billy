import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { holdsUntrustedContent } from "../notes/note.ts";
import { Profile } from "../profile/profile.ts";
import {
  ownerCurrentTimeText,
  ownerTimeZone,
} from "../time/owner-current-time.ts";
import { Conversation } from "./conversation.ts";
import { recentChatSection } from "./recent-chat-section.ts";
import { storeFinishedTurn } from "./stored-turn.ts";
import type { FinishedTurn } from "./stored-turn.ts";
import { ownerContextBlock, systemPrompt } from "./system-prompt.ts";
import { runBlock, turnContextBlock, withTurnContext } from "./turn-context.ts";
import { TurnProgress } from "./turn-progress.ts";
import { writeBackMessageOf } from "./write-back.ts";
import type { WriteBackMarker } from "./write-back.ts";

interface SessionRequestInput {
  readonly eventId: string;
  readonly behavior: BehaviorConfig;
  readonly instructions: readonly string[];
  readonly situation: readonly string[];
  readonly inputs: readonly ModelMessage[];
  readonly earlier: readonly ModelMessage[];
}

const ownerContextOf = Effect.fnUntraced(function* ownerContextOf(
  behavior: BehaviorConfig
) {
  const profile = yield* Profile;
  return ownerContextBlock(yield* profile.read, yield* ownerTimeZone(behavior));
});

const conversationRequest = Effect.fnUntraced(function* conversationRequest({
  eventId,
  behavior,
  instructions,
  situation,
  inputs,
  earlier,
}: SessionRequestInput) {
  const conversation = yield* Conversation;
  const history = yield* conversation.history;
  const ownerContext = yield* ownerContextOf(behavior);
  const turnContext = turnContextBlock(
    yield* ownerCurrentTimeText(behavior),
    situation
  );
  yield* (yield* TurnProgress).recordTurnContext(eventId, turnContext);
  return {
    system: systemPrompt({ behavior, instructions }),
    turnContext,
    messages: [
      ownerContext,
      ...history,
      ...withTurnContext(turnContext, inputs),
      ...earlier,
    ],
  };
});

const sideSessionRequest: typeof conversationRequest = Effect.fnUntraced(
  function* sideSessionRequest({
    eventId,
    behavior,
    instructions,
    situation,
    inputs,
    earlier,
  }: SessionRequestInput) {
    const conversation = yield* Conversation;
    const recentChat = yield* conversation.recentTextRows(
      behavior.sideSessionRecentChatMessages
    );
    const ownerContext = yield* ownerContextOf(behavior);
    const block = runBlock(yield* ownerCurrentTimeText(behavior), [
      recentChatSection(recentChat),
      ...situation,
    ]);
    yield* (yield* TurnProgress).recordTurnContext(eventId, block);
    return {
      system: systemPrompt({ behavior, instructions }),
      turnContext: block,
      messages: [ownerContext, ...withTurnContext(block, inputs), ...earlier],
    };
  }
);

const writeBackOf = Effect.fnUntraced(function* writeBackOf(
  marker: WriteBackMarker,
  { eventId, turnContext, inputs, steps, ending }: FinishedTurn
) {
  if (ending._tag !== "Replied") {
    return;
  }
  const conversation = yield* Conversation;
  yield* conversation.append({
    eventId,
    rows: [
      {
        kind: "write_back",
        message: writeBackMessageOf({
          marker,
          text: ending.text,
          steps,
          heldUntrustedContent: holdsUntrustedContent([
            turnContext,
            inputs,
            steps,
            ending.text,
          ]),
        }),
      },
    ],
  });
});

const failureNoticeWriteBackOf = Effect.fnUntraced(
  function* failureNoticeWriteBackOf(
    marker: WriteBackMarker,
    eventId: string,
    text: string
  ) {
    const conversation = yield* Conversation;
    const progress = yield* TurnProgress;
    yield* conversation.append({
      eventId,
      recordedAs: `${eventId}:failure-notice`,
      rows: [
        {
          kind: "write_back",
          message: writeBackMessageOf({
            marker,
            text,
            steps: yield* progress.completedFor(eventId),
            heldUntrustedContent: holdsUntrustedContent(text),
          }),
        },
      ],
    });
  }
);

export interface TurnSession {
  readonly kind: "MainConversation" | "SideSession";
  readonly request: typeof conversationRequest;
  readonly commit: typeof storeFinishedTurn;
  readonly rememberFailureNotice: (
    eventId: string,
    text: string
  ) => ReturnType<typeof failureNoticeWriteBackOf>;
}

export const mainConversation: TurnSession = {
  kind: "MainConversation",
  request: conversationRequest,
  commit: storeFinishedTurn,
  rememberFailureNotice: () => Effect.void,
};

export const sideSession = (marker: WriteBackMarker): TurnSession => ({
  kind: "SideSession",
  request: sideSessionRequest,
  commit: (turn) => writeBackOf(marker, turn),
  rememberFailureNotice: (eventId, text) =>
    failureNoticeWriteBackOf(marker, eventId, text),
});
