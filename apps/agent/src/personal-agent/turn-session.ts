import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Profile } from "../profile/profile.ts";
import {
  ownerCurrentTimeText,
  ownerTimeZone,
} from "../time/owner-current-time.ts";
import { Conversation } from "./conversation.ts";
import { storeFinishedTurn } from "./stored-turn.ts";
import {
  ownerContextBlock,
  systemPrompt,
  turnContextBlock,
} from "./system-prompt.ts";
import { TurnProgress } from "./turn-progress.ts";

interface SessionRequestInput {
  readonly eventId: string;
  readonly behavior: BehaviorConfig;
  readonly instructions: readonly string[];
  readonly situation: readonly string[];
  readonly inputs: readonly ModelMessage[];
  readonly earlier: readonly ModelMessage[];
}

const conversationRequest = Effect.fnUntraced(function* conversationRequest({
  eventId,
  behavior,
  instructions,
  situation,
  inputs,
  earlier,
}: SessionRequestInput) {
  const conversation = yield* Conversation;
  const profile = yield* Profile;
  const history = yield* conversation.history;
  const ownerContext = ownerContextBlock(
    yield* profile.read,
    yield* ownerTimeZone(behavior)
  );
  const turnContext = turnContextBlock(
    yield* ownerCurrentTimeText(behavior),
    situation
  );
  yield* (yield* TurnProgress).recordTurnContext(eventId, turnContext);
  return {
    system: systemPrompt({ behavior, instructions }),
    history,
    turnContext,
    messages: [ownerContext, ...history, turnContext, ...inputs, ...earlier],
  };
});

export interface TurnSession {
  readonly kind: "MainConversation" | "SideSession";
  readonly request: typeof conversationRequest;
  readonly commit: typeof storeFinishedTurn;
}

export const mainConversation: TurnSession = {
  kind: "MainConversation",
  request: conversationRequest,
  commit: storeFinishedTurn,
};

export const sideSession: TurnSession = {
  kind: "SideSession",
  request: conversationRequest,
  commit: storeFinishedTurn,
};
