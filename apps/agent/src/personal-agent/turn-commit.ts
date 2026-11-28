import type { ModelMessage } from "ai";

import type { TurnTrust } from "../approval/turn-trust.ts";
import type { FinishedTurn, TurnEnding } from "./stored-turn.ts";
import type { TurnSession } from "./turn-session.ts";

type RunningTurn = Pick<FinishedTurn, "eventId" | "turnContext" | "inputs">;

export const turnCommitOf =
  (session: TurnSession, turn: RunningTurn, trust: TurnTrust) =>
  (steps: readonly ModelMessage[], ending: TurnEnding) =>
    session.commit({ ...turn, steps, ending, trustLevel: trust.current() });
