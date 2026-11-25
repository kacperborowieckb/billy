import type { ModelMessage } from "ai";
import { Option } from "effect";

import type { BehaviorConfig } from "../behavior/behavior-config.ts";
import type { ReportedStep } from "../model-gateway/usage-ledger.ts";
import type { StoredConversationRow } from "./conversation.ts";

export interface CompactionBlock {
  readonly previousSummary: Option.Option<ModelMessage>;
  readonly messages: readonly ModelMessage[];
  readonly lastCompactedSequence: number;
}

interface StoredTurn {
  readonly eventId: string;
  readonly rows: readonly StoredConversationRow[];
}

export type CompactionLimits = Pick<
  BehaviorConfig,
  "compactionHistoryTokenLimit" | "compactionKeptTokens"
>;

const storedTurnsOf = (rows: readonly StoredConversationRow[]) => {
  const turns: { eventId: string; rows: StoredConversationRow[] }[] = [];
  for (const row of rows) {
    const last = turns.at(-1);
    if (last?.eventId === row.eventId) {
      last.rows.push(row);
    } else {
      turns.push({ eventId: row.eventId, rows: [row] });
    }
  }
  return turns satisfies readonly StoredTurn[];
};

interface TurnTokens {
  readonly atStart: number;
  readonly atEnd: number;
}

const tokensByEvent = (steps: readonly ReportedStep[]) => {
  const byEvent = new Map<string, TurnTokens>();
  for (const { eventId, inputTokens, outputTokens } of steps) {
    if (inputTokens !== null) {
      byEvent.set(eventId, {
        atStart: byEvent.get(eventId)?.atStart ?? inputTokens,
        atEnd: inputTokens + (outputTokens ?? 0),
      });
    }
  }
  return byEvent;
};

const turnStartsOf = (
  turns: readonly StoredTurn[],
  steps: readonly ReportedStep[]
) => {
  const reported = tokensByEvent(steps);
  let previousEnd: number | undefined;
  return turns.map((turn) => {
    const tokens = reported.get(turn.eventId);
    const start =
      tokens === undefined ? undefined : (previousEnd ?? tokens.atStart);
    previousEnd = tokens?.atEnd ?? previousEnd;
    return start;
  });
};

interface CutPoint {
  readonly index: number;
  readonly tokensFromHere: number;
}

const cutIndexOf = (cutPoints: readonly CutPoint[], keptTokens: number) =>
  Option.fromNullishOr(
    (
      cutPoints.find((point) => point.tokensFromHere <= keptTokens) ??
      cutPoints.at(-1)
    )?.index
  );

export const historyTokensOverLimit = (
  stepsSinceSummary: readonly ReportedStep[],
  limits: CompactionLimits
): Option.Option<number> =>
  Option.fromNullishOr(stepsSinceSummary.at(-1)?.inputTokens).pipe(
    Option.filter((tokens) => tokens > limits.compactionHistoryTokenLimit)
  );

interface CompactionInputs {
  readonly rows: readonly StoredConversationRow[];
  readonly stepsSinceSummary: readonly ReportedStep[];
  readonly historyTokens: number;
}

export const compactionBlockOf = (
  { rows, stepsSinceSummary, historyTokens }: CompactionInputs,
  limits: CompactionLimits
): Option.Option<CompactionBlock> => {
  const turns = storedTurnsOf(rows.filter((row) => row.kind !== "summary"));
  const starts = turnStartsOf(turns, stepsSinceSummary);
  const cutPoints = starts.flatMap((startTokens, index): CutPoint[] =>
    index === 0 || startTokens === undefined
      ? []
      : [{ index, tokensFromHere: historyTokens - startTokens }]
  );
  return cutIndexOf(cutPoints, limits.compactionKeptTokens).pipe(
    Option.flatMap((cut) => {
      const blockRows = turns.slice(0, cut).flatMap((turn) => turn.rows);
      const lastRow = blockRows.at(-1);
      return lastRow === undefined
        ? Option.none()
        : Option.some({
            previousSummary: Option.fromNullishOr(
              rows.find((row) => row.kind === "summary")?.message
            ),
            messages: blockRows.map((row) => row.message),
            lastCompactedSequence: lastRow.sequence,
          });
    })
  );
};
