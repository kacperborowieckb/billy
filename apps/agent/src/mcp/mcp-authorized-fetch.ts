import type { McpCatalogEntry } from "./mcp-catalog.ts";
import type {
  McpConnectionHealth,
  AccessOutcome,
} from "./mcp-connection-health.ts";
import type { FetchFunction } from "./mcp-outbound-guard.ts";
import { McpRefreshUnavailableError } from "./mcp-refresh-unavailable-error.ts";
import { McpSignInRequiredError } from "./mcp-sign-in-required-error.ts";

export const mcpRequestDeadlineMillis = 120_000;

export interface McpAuthorizedFetchInput {
  readonly send: FetchFunction;
  readonly entry: McpCatalogEntry;
  readonly ownerId: string;
  readonly health: McpConnectionHealth;
  readonly queueWaitsOnConnect: () => boolean;
}

const challengeParameterPattern =
  /(?<name>[\w-]+)\s*=\s*(?:"(?<quoted>(?:[^"\\]|\\.)*)"|(?<bare>[^\s,"]*))/gu;

const isInsufficientScope = (response: Response) =>
  response.status === 403 &&
  [
    ...(response.headers.get("WWW-Authenticate") ?? "").matchAll(
      challengeParameterPattern
    ),
  ].some(({ groups }) => {
    const { name, quoted, bare } = groups ?? {};
    return (
      name?.toLowerCase() === "error" &&
      (quoted ?? bare) === "insufficient_scope"
    );
  });

const tokenFrom = (outcome: AccessOutcome) => {
  if (outcome._tag === "SignInRequired") {
    throw new McpSignInRequiredError("The MCP Connection needs a new sign-in");
  }
  if (outcome._tag === "Unavailable") {
    throw new McpRefreshUnavailableError("The MCP token refresh failed");
  }
  return outcome.accessToken;
};

const attemptOf = (
  send: FetchFunction,
  base: Request,
  accessToken: string | undefined
) => {
  const headers = new Headers(base.headers);
  if (accessToken !== undefined) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  const deadline =
    base.method === "GET"
      ? []
      : [AbortSignal.timeout(mcpRequestDeadlineMillis)];
  return send(
    new Request(base.clone(), {
      headers,
      signal: AbortSignal.any([base.signal, ...deadline]),
    })
  );
};

const refusedNote = (
  response: Response
):
  | {
      readonly reason: "unauthorized" | "insufficient_scope";
      readonly httpStatus: number;
    }
  | undefined => {
  if (response.status === 401) {
    return { reason: "unauthorized", httpStatus: 401 };
  }
  return isInsufficientScope(response)
    ? { reason: "insufficient_scope", httpStatus: 403 }
    : undefined;
};

export const authorizedFetch =
  ({
    send,
    entry,
    ownerId,
    health,
    queueWaitsOnConnect,
  }: McpAuthorizedFetchInput): FetchFunction =>
  async (input, init) => {
    const base = new Request(input, init);
    const holdsQueue = queueWaitsOnConnect();
    const used = tokenFrom(
      holdsQueue
        ? await health.storedAccessToken(entry, ownerId)
        : await health.accessTokenFor(entry, ownerId)
    );
    const first = await attemptOf(send, base, used);
    const firstRefusal = refusedNote(first);
    if (firstRefusal === undefined) {
      return first;
    }
    await first.body?.cancel();
    if (queueWaitsOnConnect()) {
      throw new McpRefreshUnavailableError("The MCP server refused the tokens");
    }
    const recovered = tokenFrom(
      firstRefusal.reason === "unauthorized"
        ? await health.recoverFromRejection(entry, ownerId, used)
        : await health.confirmRejection({
            entry,
            ownerId,
            rejectedAccessToken: used,
            note: { phase: "request", ...firstRefusal },
          })
    );
    const second = await attemptOf(send, base, recovered);
    const secondRefusal = refusedNote(second);
    if (secondRefusal === undefined) {
      return second;
    }
    await second.body?.cancel();
    tokenFrom(
      await health.confirmRejection({
        entry,
        ownerId,
        rejectedAccessToken: recovered,
        note: { phase: "request", ...secondRefusal },
      })
    );
    throw new McpSignInRequiredError("The MCP Connection needs a new sign-in");
  };
