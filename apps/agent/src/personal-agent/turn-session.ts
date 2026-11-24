import type { ModelMessage } from "ai";
import { Effect } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import { Profile } from "../profile/profile.ts";
import { ownerCurrentTimeText } from "../time/owner-current-time.ts";
import { Conversation } from "./conversation.ts";
import { storeFinishedTurn } from "./stored-turn.ts";
import { systemPrompt } from "./system-prompt.ts";

interface SessionRequestInput {
  readonly behavior: BehaviorConfig;
  readonly situation: readonly string[];
  readonly inputs: readonly ModelMessage[];
  readonly earlier: readonly ModelMessage[];
}

const conversationRequest = Effect.fnUntraced(function* conversationRequest({
  behavior,
  situation,
  inputs,
  earlier,
}: SessionRequestInput) {
  const conversation = yield* Conversation;
  const profile = yield* Profile;
  const history = yield* conversation.recent;
  const system = systemPrompt({
    behavior,
    profile: yield* profile.read,
    currentTime: yield* ownerCurrentTimeText(behavior),
    situation,
  });
  return { system, history, messages: [...history, ...inputs, ...earlier] };
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
