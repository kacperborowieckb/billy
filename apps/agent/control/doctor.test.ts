import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  diagnose,
  isHealthy,
  operatorMetricsDatasetOf,
  renderDiagnosis,
} from "./doctor.ts";
import { hitRateSourceOf, readHitRate } from "./hit-rate.ts";
import { wranglerConfigPath } from "./workspace.ts";

const secretValues = {
  AI_GATEWAY_TOKEN: "value-of-ai-gateway-token-7f3a",
  OPERATOR_TOKEN: "value-of-operator-token-2b6c",
  TELEGRAM_BOT_TOKEN: "value-of-telegram-bot-token-91c2",
  TELEGRAM_WEBHOOK_SECRET: "value-of-telegram-webhook-secret-4e8d",
};

const instanceWith = ({
  config = readFileSync(wranglerConfigPath, "utf-8"),
  devVars,
}: {
  readonly config?: string;
  readonly devVars: Record<string, string>;
}) => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "agent-doctor-"));
  mkdirSync(nodePath.join(directory, "src"));
  writeFileSync(nodePath.join(directory, "src", "index.ts"), "");
  writeFileSync(nodePath.join(directory, "wrangler.jsonc"), config);
  writeFileSync(
    nodePath.join(directory, ".dev.vars"),
    Object.entries(devVars)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")
  );
  return nodePath.join(directory, "wrangler.jsonc");
};

describe("doctor", () => {
  it("reports a complete configuration as healthy without printing secret values", () => {
    const diagnosis = diagnose(instanceWith({ devVars: secretValues }));
    const report = renderDiagnosis(diagnosis);

    expect(isHealthy(diagnosis)).toBe(true);
    for (const [name, value] of Object.entries(secretValues)) {
      expect(report).toContain(`${name} is set`);
      expect(report).not.toContain(value);
    }
  });

  it("names each missing secret", () => {
    const diagnosis = diagnose(
      instanceWith({
        devVars: { TELEGRAM_BOT_TOKEN: secretValues.TELEGRAM_BOT_TOKEN },
      })
    );
    const report = renderDiagnosis(diagnosis);

    expect(isHealthy(diagnosis)).toBe(false);
    expect(report).toContain("TELEGRAM_BOT_TOKEN is set");
    expect(report).toContain("TELEGRAM_WEBHOOK_SECRET is missing");
    expect(report).toContain("AI_GATEWAY_TOKEN is missing");
    expect(report).toContain("OPERATOR_TOKEN is missing");
    expect(report).not.toContain(secretValues.TELEGRAM_BOT_TOKEN);
  });

  it("reports a Personal Agent without SQLite storage as a problem", () => {
    const config = readFileSync(wranglerConfigPath, "utf-8").replace(
      '"new_sqlite_classes"',
      '"new_classes"'
    );
    const diagnosis = diagnose(instanceWith({ config, devVars: secretValues }));

    expect(isHealthy(diagnosis)).toBe(false);
    expect(renderDiagnosis(diagnosis)).toContain(
      "problem  Durable Object PERSONAL_AGENT: PersonalAgent without a SQLite migration"
    );
  });
});

const metricAnswer = (rows: readonly object[]) =>
  Response.json({ meta: [], data: rows, rows: rows.length });

const hitRateOf = async (answer: Response) => {
  const requests: Request[] = [];
  const result = await Effect.runPromise(
    readHitRate(
      hitRateSourceOf(
        {
          CLOUDFLARE_ACCOUNT_ID: "account-1",
          CLOUDFLARE_API_TOKEN: "value-of-cloudflare-api-token-5d1e",
          CLOUDFLARE_API_BASE_URL: "https://cloudflare.fake/client/v4",
        },
        "assistant_operator_metrics",
        (input, init) => {
          requests.push(new Request(input, init));
          return Promise.resolve(answer);
        }
      )
    )
  );
  const diagnosis = {
    ...diagnose(instanceWith({ devVars: secretValues })),
    hitRate: result,
  };
  return { requests, diagnosis, report: renderDiagnosis(diagnosis) };
};

describe("doctor Hit Rate check", () => {
  it("passes when both step groups are above their limits, and counts only calls with no planned miss", async () => {
    const { requests, diagnosis, report } = await hitRateOf(
      metricAnswer([
        { step_group: "in_turn", input_tokens: 10_000, cached_tokens: 9500 },
        {
          step_group: "cross_turn",
          input_tokens: "8000",
          cached_tokens: "7200",
        },
      ])
    );

    expect(isHealthy(diagnosis)).toBe(true);
    expect(report).toContain(
      "ok       Step 2 and later: 95.0% of 10000 input tokens (limit 90.0%)"
    );
    expect(report).toContain(
      "ok       Step 1 inside 60 minutes: 90.0% of 8000 input tokens (limit 80.0%)"
    );
    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "https://cloudflare.fake/client/v4/accounts/account-1/analytics_engine/sql"
    );
    expect(request?.headers.get("Authorization")).toBe(
      "Bearer value-of-cloudflare-api-token-5d1e"
    );
    const query = (await request?.text()) ?? "";
    expect(query).toContain("FROM assistant_operator_metrics");
    expect(query).toContain("blob1 = 'model_step'");
    expect(query).toContain("blob2 = 'none'");
    expect(query).toContain("INTERVAL '24' HOUR");
    expect(query).toContain("double9 >= 0 AND double9 <= 60");
    expect(report).not.toContain("value-of-cloudflare-api-token-5d1e");
  });

  it("fails when step 2 and later is below 90%", async () => {
    const { diagnosis, report } = await hitRateOf(
      metricAnswer([
        { step_group: "in_turn", input_tokens: 10_000, cached_tokens: 8999 },
        { step_group: "cross_turn", input_tokens: 1000, cached_tokens: 900 },
      ])
    );

    expect(isHealthy(diagnosis)).toBe(false);
    expect(report).toContain(
      "problem  Step 2 and later: 90.0% of 10000 input tokens (limit 90.0%)"
    );
    expect(report).toContain("Result: problems found");
  });

  it("fails when step 1 inside 60 minutes is below 80%", async () => {
    const { diagnosis, report } = await hitRateOf(
      metricAnswer([
        { step_group: "in_turn", input_tokens: 1000, cached_tokens: 1000 },
        { step_group: "cross_turn", input_tokens: 1000, cached_tokens: 790 },
      ])
    );

    expect(isHealthy(diagnosis)).toBe(false);
    expect(report).toContain(
      "problem  Step 1 inside 60 minutes: 79.0% of 1000 input tokens (limit 80.0%)"
    );
  });

  it("passes a step group with no calls", async () => {
    const { diagnosis, report } = await hitRateOf(metricAnswer([]));

    expect(isHealthy(diagnosis)).toBe(true);
    expect(report).toContain("ok       Step 2 and later: no calls");
  });

  it("fails when the metric cannot be read", async () => {
    const { diagnosis, report } = await hitRateOf(
      new Response("forbidden", { status: 403 })
    );

    expect(isHealthy(diagnosis)).toBe(false);
    expect(report).toContain(
      "problem  The Operator metric could not be read: HTTP 403"
    );
  });

  it("skips the check without Cloudflare credentials", async () => {
    const hitRate = await Effect.runPromise(
      readHitRate(hitRateSourceOf({}, "assistant_operator_metrics"))
    );
    const diagnosis = {
      ...diagnose(instanceWith({ devVars: secretValues })),
      hitRate,
    };

    expect(isHealthy(diagnosis)).toBe(true);
    expect(renderDiagnosis(diagnosis)).toContain(
      "skipped  Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN"
    );
  });

  it("reads the dataset of the Operator metric from the Wrangler config", () => {
    expect(operatorMetricsDatasetOf(wranglerConfigPath)).toBe(
      "assistant_operator_metrics"
    );
  });
});
