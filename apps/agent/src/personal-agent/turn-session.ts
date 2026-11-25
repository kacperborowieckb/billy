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

const newRunBlock = Effect.fnUntraced(function* newRunBlock(
  behavior: BehaviorConfig,
  situation: readonly string[]
) {
  const conversation = yield* Conversation;
  const recentChat = yield* conversation.recentTextRows(
    behavior.sideSessionRecentChatMessages
  );
  return runBlock(yield* ownerCurrentTimeText(behavior), [
    recentChatSection(recentChat),
    ...situation,
  ]);
});

const recordedRunBlockOr = Effect.fnUntraced(function* recordedRunBlockOr<
  Failure,
  Requirements,
>(eventId: string, build: Effect.Effect<string, Failure, Requirements>) {
  const progress = yield* TurnProgress;
  const recorded = yield* progress.turnContextFor(eventId);
  if (recorded !== undefined) {
    return recorded;
  }
  const block = yield* build;
  yield* progress.recordTurnContext(eventId, block);
  return block;
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
    const ownerContext = yield* ownerContextOf(behavior);
    const block = yield* recordedRunBlockOr(
      eventId,
      newRunBlock(behavior, situation)
    );
    return {
      system: systemPrompt({ behavior, instructions }),
      turnContext: block,
      messages: [ownerContext, ...withTurnContext(block, inputs), ...earlier],
    };
  }
);

interface SentRun {
  readonly marker: WriteBackMarker;
  readonly eventId: string;
  readonly recordedAs?: string | undefined;
  readonly turnContext: string | undefined;
  readonly inputs: readonly ModelMessage[];
  readonly steps: readonly ModelMessage[];
  readonly text: string;
}

const appendWriteBack = Effect.fnUntraced(function* appendWriteBack({
  marker,
  eventId,
  recordedAs,
  turnContext,
  inputs,
  steps,
  text,
}: SentRun) {
  const conversation = yield* Conversation;
  const heldUntrustedContent = holdsUntrustedContent([
    turnContext,
    inputs,
    steps,
    text,
  ]);
  yield* conversation.append({
    eventId,
    recordedAs,
    rows: [
      {
        kind: heldUntrustedContent ? "write_back_stub" : "write_back",
        message: writeBackMessageOf({
          marker,
          text,
          steps,
          heldUntrustedContent,
        }),
      },
    ],
  });
});

const writeBackOf = (
  marker: WriteBackMarker,
  { eventId, turnContext, inputs, steps, ending }: FinishedTurn
) =>
  ending._tag === "Replied"
    ? appendWriteBack({
        marker,
        eventId,
        turnContext,
        inputs,
        steps,
        text: ending.text,
      })
    : Effect.void;

const failureNoticeWriteBackOf = Effect.fnUntraced(
  function* failureNoticeWriteBackOf(
    marker: WriteBackMarker,
    eventId: string,
    text: string
  ) {
    const progress = yield* TurnProgress;
    yield* appendWriteBack({
      marker,
      eventId,
      recordedAs: `${eventId}:failure-notice`,
      turnContext: yield* progress.turnContextFor(eventId),
      inputs: [],
      steps: yield* progress.completedFor(eventId),
      text,
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
