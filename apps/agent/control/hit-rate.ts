import { Effect, Schema } from "effect";

import {
  cacheLifetimeMinutes,
  noPlannedMiss,
} from "../src/tracing/hit-rate-values.ts";

export const hitRateWindowHours = 24;

export const stepGroups = [
  {
    name: "in_turn",
    label: "Step 2 and later",
    limit: 0.9,
  },
  {
    name: "cross_turn",
    label: `Step 1 inside ${cacheLifetimeMinutes} minutes`,
    limit: 0.8,
  },
] as const;

type StepGroupName = (typeof stepGroups)[number]["name"];

export interface HitRateSource {
  readonly accountId: string;
  readonly apiToken: string;
  readonly apiBaseUrl: string;
  readonly dataset: string;
  readonly fetch: typeof fetch;
}

export interface StepGroupTokens {
  readonly inputTokens: number;
  readonly cachedTokens: number;
}

export type HitRateResult =
  | { readonly _tag: "NotConfigured" }
  | { readonly _tag: "Unreadable"; readonly reason: string }
  | {
      readonly _tag: "Measured";
      readonly groups: Readonly<Record<StepGroupName, StepGroupTokens>>;
    };

export interface HitRateFinding {
  readonly ok: boolean;
  readonly label: string;
}

const defaultApiBaseUrl = "https://api.cloudflare.com/client/v4";

const datasetName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9_]+$/u))
);

export const hitRateSourceOf = (
  environment: Readonly<Record<string, string | undefined>>,
  dataset: string,
  fetchImplementation: typeof fetch = fetch
): HitRateSource | undefined => {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  if (
    accountId === undefined ||
    accountId === "" ||
    apiToken === undefined ||
    apiToken === ""
  ) {
    return undefined;
  }
  return {
    accountId,
    apiToken,
    apiBaseUrl: environment.CLOUDFLARE_API_BASE_URL ?? defaultApiBaseUrl,
    dataset: Schema.decodeUnknownSync(datasetName)(dataset),
    fetch: fetchImplementation,
  };
};

export const hitRateQuery = (dataset: string) =>
  [
    "SELECT if(double6 >= 2, 'in_turn', 'cross_turn') AS step_group,",
    "SUM(_sample_interval * double2) AS input_tokens,",
    "SUM(_sample_interval * double5) AS cached_tokens",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${hitRateWindowHours}' HOUR`,
    "AND blob1 = 'model_step'",
    `AND blob2 = '${noPlannedMiss}'`,
    `AND (double6 >= 2 OR (double9 >= 0 AND double9 <= ${cacheLifetimeMinutes}))`,
    "GROUP BY step_group",
  ].join(" ");

const TokenCount = Schema.Union([Schema.Number, Schema.NumberFromString]);

const HitRateRowsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      step_group: Schema.Literals(["in_turn", "cross_turn"]),
      input_tokens: TokenCount,
      cached_tokens: TokenCount,
    })
  ),
});

const noTokens: StepGroupTokens = { inputTokens: 0, cachedTokens: 0 };

const unreadable = (reason: string): HitRateResult => ({
  _tag: "Unreadable",
  reason,
});

const measuredOf = (rows: typeof HitRateRowsSchema.Type): HitRateResult => {
  const tokensOf = (name: StepGroupName): StepGroupTokens => {
    const row = rows.data.find((candidate) => candidate.step_group === name);
    return row === undefined
      ? noTokens
      : { inputTokens: row.input_tokens, cachedTokens: row.cached_tokens };
  };
  return {
    _tag: "Measured",
    groups: {
      in_turn: tokensOf("in_turn"),
      cross_turn: tokensOf("cross_turn"),
    },
  };
};

export const readHitRate = (source: HitRateSource | undefined) =>
  source === undefined
    ? Effect.succeed<HitRateResult>({ _tag: "NotConfigured" })
    : Effect.tryPromise(async () => {
        const response = await source.fetch(
          `${source.apiBaseUrl}/accounts/${source.accountId}/analytics_engine/sql`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${source.apiToken}` },
            body: hitRateQuery(source.dataset),
          }
        );
        return response.ok
          ? {
              status: response.status,
              body: (await response.json()) as unknown,
            }
          : { status: response.status, body: undefined };
      }).pipe(
        Effect.flatMap(({ status, body }) =>
          body === undefined
            ? Effect.succeed(unreadable(`HTTP ${status}`))
            : Schema.decodeUnknownEffect(HitRateRowsSchema)(body).pipe(
                Effect.map(measuredOf),
                Effect.orElseSucceed(() =>
                  unreadable("the answer has an unknown shape")
                )
              )
        ),
        Effect.orElseSucceed(() => unreadable("the request failed"))
      );

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

export const hitRateFindings = (
  result: HitRateResult
): readonly HitRateFinding[] => {
  if (result._tag === "NotConfigured") {
    return [];
  }
  if (result._tag === "Unreadable") {
    return [
      {
        ok: false,
        label: `The Operator metric could not be read: ${result.reason}`,
      },
    ];
  }
  return stepGroups.map(({ name, label, limit }) => {
    const { inputTokens, cachedTokens } = result.groups[name];
    if (inputTokens === 0) {
      return { ok: true, label: `${label}: no calls` };
    }
    const hitRate = cachedTokens / inputTokens;
    return {
      ok: hitRate >= limit,
      label: `${label}: ${percent(hitRate)} of ${inputTokens} input tokens (limit ${percent(limit)})`,
    };
  });
};
