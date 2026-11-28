# MCP: the OAuth flow of the library with a sealing storage adapter

Date: 2026-11-28

Issue: [#250](https://github.com/kacperborowieckb/billy/issues/250), spec [#255](https://github.com/kacperborowieckb/billy/issues/255). Decision: [0036](../decisions/0036-mcp-connections.md). Code on `main` at `bf6c6d7`. All servers and tokens in this research are fakes.

## Recommendation: keep our code

Do not replace the hand-written OAuth flow with the library flow. Do not replace a part of the flow now. No follow-up ticket is filed.

The sealing problem is solved: a small storage adapter seals every record of the library. That was the only recorded reason to switch the library logic off. The research found other reasons to keep it off:

1. The library has no single flight. With refresh token rotation, a late refresh deletes the new tokens.
2. A token endpoint that is down gives the same error as a refused refresh token.
3. A callback with a wrong `iss` uses up the state. Decision 0036 forbids this.
4. A replayed or unknown callback reports success when the connection object looks accepted.
5. The guard against a second account is in memory. A second callback can replace the tokens.
6. A replacement removes about 780 lines and needs about 300 new lines. The queue, the states, the replay, and the revocation stay.

## Method

Versions: `agents` 0.33.0, `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/core` 2.4.0. Line numbers below are in these files:

| Short name | File in the package                                     |
| ---------- | ------------------------------------------------------- |
| provider   | `agents/dist/mcp/client/do-oauth-client-provider.js`    |
| manager    | `agents/dist/client-DMWujQJ1.js`                        |
| auth       | `@modelcontextprotocol/client/dist/public-CvV4ZHkX.mjs` |

Three kinds of evidence:

- **Adapter.** [`sealed-oauth-storage.ts`](../../apps/agent/src/mcp/sealed-oauth-storage.ts) has the four storage calls that the provider uses (`get`, `put`, `delete`, `list`). `put` seals with `seal` of `token-seal.ts`, and `get` and `list` open. No production code uses it. [`mcp-sealed-oauth-storage.test.ts`](../../apps/agent/test/mcp-sealed-oauth-storage.test.ts) tests it.
- **Library tests.** [`mcp-library-oauth-flow.test.ts`](../../apps/agent/test/mcp-library-oauth-flow.test.ts) runs `DurableObjectOAuthClientProvider` over the adapter, in the `MCPClientManager` of an MCP Hub, against the fake MCP server. The requests go through `mcp-outbound-guard.ts`. The tests assert the behavior of the library, also where Billy must not have it. A library upgrade that changes a behavior fails a test.
- **Spike.** A throwaway change connected the library flow to the real Edge, Personal Agent, and MCP Hub. It is not in the repository. See [The existing tests](#the-existing-tests).

The fake OAuth server now sends `response_types_supported` in its metadata and `redirect_uris` in its registration answer. RFC 8414 and RFC 7591 require both. The library refuses an answer without them. Billy accepts one.

## Answers

### Associated data: can the adapter derive it from the key?

In part. The catalog id and the purpose: yes. The Owner Id: no.

- The key of the provider is `/<client name>/<server id>/...`. The rest names the purpose: `<client id>/token`, `<client id>/client_info/`, `<client id>/code_verifier...`, `state/<nonce>`, or `oauth_discovery` (provider, `keyPrefix` and the functions after it).
- The adapter does not parse the key. It binds the whole key, which holds the server id and the purpose. A record that is copied to another Connection or purpose does not open. The server id is the catalog id only if Billy registers the server under the catalog id. Tests: `does not open a record that was copied to another Connection`, `... another purpose`, `does not open the record of another Owner`.
- The Owner Id is not in the key. The adapter gets it in its constructor and binds it too, so a record of another Owner does not open. The client name cannot carry the Owner Id, because the library also sends the client name to the authorization server as `client_name`.

Conditions for a replacement:

- The server id must be stable and equal to the catalog id. Billy uses `<catalog id>:<epoch>` today. The tokens would be lost at each new epoch.
- `removeServer` deletes all records of the server id (manager, line 2214). `McpSdkServers.retire` calls it after a deadline. A retire must close the connection and keep the records.
- The manager must get `createAuthProvider`. Without it, a provider that the manager makes writes plain values to the hub storage (manager, lines 1407 and 1469).
- `migrateServerId` moves records without the adapter (manager, line 1205). A moved record does not open. Billy does not call it.
- The provider type does not compile with `exactOptionalPropertyTypes`, so it needs a type assertion.

### Refresh: one request for two calls?

No. Two calls at the same time send two refresh requests. The transport calls `auth()` for each 401 (auth, `handleOAuthUnauthorized`, line 252), and nothing joins the calls. Test: `makes one token request for each call that needs it`.

With rotation, the order matters. The first refresh saves the new tokens. The second refresh gets `invalid_grant` for the old token, and `auth()` then deletes the stored tokens (auth, line 640). The Connection that was good needs a new sign-in. Test: `deletes a rotated token when an older refresh is refused later`.

The library also refreshes only after a 401. It does not read `expires_in`.

### Refresh: a rotated refresh token that is lost?

- The call fails with `UnauthorizedError`. The old tokens stay.
- The next refresh gets `invalid_grant`. The library deletes the tokens, and the call fails with `UnauthorizedError`. Test: `deletes the tokens after a rotated refresh token was lost`.
- The library sets no deadline on the token request, so a response body that never ends is not stopped. The test adds a deadline in the fetch function.

### Callback: `iss`, one use of the state, and replay

| Rule of decision 0036 | Library | Evidence |
| --- | --- | --- |
| A wrong `iss` is refused | Yes | `refuses a wrong iss and uses up the state` |
| A missing `iss` is refused when the server promised it | Yes | `refuses no iss and uses up the state` |
| A refused `iss` changes nothing | **No.** The manager uses up the state before the `iss` check, and marks the connection failed. The real callback is then refused | same tests, manager line 1882 |
| An unknown state changes nothing | **In part.** The pending request stays. The callback is refused only while the connection object is `authenticating` or `failed`. In other states it reports success (see the replay row) | `ignores an unknown state and keeps the pending request`, `exchanges one time and reports success for any later callback` |
| One exchange for one state | Yes, also for two callbacks at the same time | `exchanges one time and reports success for any later callback` |
| A replay is checked | **No.** When the connection object is `connecting`, `connected`, `discovering`, or `ready`, every callback with a state of that server reports success, also an unknown state and a second callback while the exchange still runs | same test, manager line 1339 |
| A replay finishes a connect that failed after the exchange | **No** | spike |

RFC 7636 PKCE: the library refuses a server that lists methods without S256, but accepts a server that lists no methods (auth, line 1205). Billy refuses both.

### One account for each Connection

A second callback **can** replace the tokens. The only guard is the state of the connection object in memory. The library has no record of a Connection that is done.

Test `replaces the tokens with a second callback after one failed refresh`:

1. Two starts make two pending states. The newer one connects.
2. The connection object is made again, as after a retire or a wake.
3. The token endpoint answers 503 one time. The connection becomes `authenticating`.
4. The older callback arrives. The library exchanges its code and replaces the tokens.

The refresh token of the first sign-in was still good. The stored tokens now belong to the other sign-in, which can be another account, and no record shows the change.

A related result: after the connection object is gone, a callback fails with `No connection found`. After the object is registered again but did not connect, the callback reports success and exchanges nothing (tests `finds no connection ...` and `reports success with no exchange ...`).

### Client mode: CIMD first, then DCR; a DCR server with a client secret

Yes, both work.

- With `clientMetadataUrl` and a server that supports it, the client id is that URL and there is no registration. Test: `connects the fake MCP server and stores no plain value`.
- Else the library registers. A returned secret is sealed and sent with `client_secret_post` or `client_secret_basic`, also at a refresh. Test: `registers with DCR and sends the returned secret with ...`.

Differences from Billy:

- Billy must keep the client id and give it to `registerServer`. Else the library registers again (test `registers again when the client id is not given again`). A server that gives a new client id then hides the stored tokens.
- For a method that it does not know (for example `client_secret_jwt`), the library picks another method. Billy fails the start before the redirect.
- The `Basic` header does not percent-encode the id and the secret (auth, line 510). RFC 6749 section 2.3.1 requires it.
- On `invalid_client` during a background refresh, the library deletes the client record and registers again (auth, line 640).

### Outbound guard and deadline

Yes for the guard, with one hole. No for the deadline.

- Discovery, registration, the code exchange, the refresh, and the MCP requests all use the `fetch` option of the transport. Test: `go through the given fetch function with no deadline of their own`.
- The guard refuses a private token endpoint (test `are refused by the outbound guard ...`). The library asks `fetch` not to follow redirects, so the guard still sees each redirect and refuses it.
- The library gives the OAuth requests no signal. The fetch function must add the deadline, and it must read the body inside the deadline. The test host does this in a few lines.
- **Hole:** the manager does not store the `fetch` option (manager, line 865). A connection that the manager restores from storage uses the global `fetch` (manager, line 1442). Billy restores nothing today.

Each refresh also runs discovery again, because `saveTokens` deletes the stored discovery state (provider, `saveTokens`). Billy stores the token endpoint at the connect.

### States: `needs sign-in` and the Reconnect button

Possible, with more code in Billy.

| Cause | What the library gives | Billy today |
| --- | --- | --- |
| `invalid_grant` | deletes the tokens, then `UnauthorizedError` | `needs sign-in` |
| `invalid_client` | deletes the client and the tokens, registers again, then `UnauthorizedError` | `needs sign-in` |
| No refresh token | `UnauthorizedError` | `needs sign-in` |
| Token endpoint 503, network error, or deadline | `UnauthorizedError`, tokens stay | stays `ready`, call fails |
| 403 `insufficient_scope` | `UnauthorizedError`, or `InsufficientScopeError` with `onInsufficientScope: "throw"` | `needs sign-in` |
| 401 after a refresh | an HTTP error `401 after re-authentication` | `needs sign-in` |

To tell the first row from the fourth, Billy needs a provider subclass that watches `invalidateCredentials`, or a fetch function that reads the status. The reason and the HTTP status of the last error come only from such code. For each cause but the last one, with the default options, the library also starts a new authorization in the background and writes a new state and verifier.

### Lazy connect: is the override still necessary?

Yes. `MCPClientManager` has no option to switch the restore off. Its constructor takes `env` and `createAuthProvider` (manager, line 1108), and `onStart` calls `restoreConnectionsFromStorage`. The method is public and not a documented extension point.

The library flow makes the problem harder. A callback needs a connection object for the server id. After a wake, only the restore makes it, and the override stops the restore. Billy would register the server again before each callback, with the guarded `fetch`, and it must then not report the false success from above.

## Decision 0036: what the library covers

| Part of decision 0036 | Library |
| --- | --- |
| Discovery, DCR, CIMD, PKCE, code exchange, refresh request, `Authorization` header | Covers, with the differences above |
| `iss` (RFC 9207) | Covers the compare. Does not keep the request |
| State and nonce | Covers one use and a 10 minute life. The format is `<nonce>.<server id>`. The Edge needs the hub routing id, so Billy must replace `state()` and change the state pattern of the Edge |
| Sealed token store | Covers with the adapter |
| `resource` (RFC 8707) | Sends it only when the server has protected resource metadata. Billy always sends it |
| Scopes | Asks for the scopes of the metadata, and adds `offline_access` with `prompt=consent`. Billy asks for none |
| Token type must be Bearer | Does not check |
| Account label | Drops `account_name` and `workspace_name` from the token response |
| `resource_metadata` challenge | Reads the parameter name only in lower case. RFC 9110 makes it case-insensitive |
| Owner proof link, consent page, GET shows and POST starts | Does not cover |
| A start begins without a 401 | Does not cover. The library starts only after a 401 |
| One queue for each Connection, single flight, interleavings | Does not cover |
| One account for each Connection, replay, `settled` marker | Does not cover |
| Connection states, Journal Entries, last error, failure logs | Does not cover |
| Disconnect and revocation (RFC 7009) | Does not cover. The packages have no function that sends a revocation request |
| Outbound guard and 3 second deadline | Billy gives them in the fetch function |

## The existing tests

The spike changed or added seven source files:

- The transport got the library provider over the adapter, in place of `SealedOAuthProvider` and `authorizedFetch`.
- The start registered the server and connected it. The callback called `handleCallbackRequest`.
- The provider got a new `state()` with the routing id, and the Edge got a new state pattern.
- The server id became the catalog id, and a retire closed the connection and kept the records.
- The fetch function got a 3 second deadline for the OAuth requests.
- `UnauthorizedError`, `InsufficientScopeError`, and the 401 after a refresh moved the Connection to `needs sign-in`.

Two shims kept known gaps from hiding other results: the fetch function kept the account label, and it answered 401 at a start when the fake did not.

| File | Pass | Fail | Fail: reads our records | Fail: behavior |
| --- | --- | --- | --- | --- |
| `mcp-connect.test.ts` | 18 | 3 | 2 | 1 |
| `mcp-oauth-callback.test.ts` | 23 | 25 | 11 | 14 |
| `mcp-token-refresh.test.ts` | 10 | 12 | 4 | 8 |
| `mcp-refresh-units.test.ts` | 12 | 0 | 0 | 0 |
| Total | 63 | 40 | 17 | 23 |

`mcp-refresh-units.test.ts` tests classes of Billy with fakes. It passes and says nothing about the library.

"Reads our records" means that the test reads the `oauth:`, `tokens:`, or `client:` records or the state format. A replacement must rewrite these 17 tests. The results do not show if the behavior behind them holds.

The 17 tests that read our records:

| File | Tests |
| --- | --- |
| `mcp-connect.test.ts` | `uses up the login proof at the first POST`; `sends the Owner to the authorization server with PKCE S256 and a state without the Owner` |
| `mcp-oauth-callback.test.ts` | `refuses a wrong nonce`; `refuses no nonce`; `refuses an unknown routing id`; `refuses a routing id of the wrong shape`; `refuses a routing id of another namespace`; `refuses an empty code and keeps the request`; `refuses an empty error and keeps the request`; `keeps no token, client secret, code, or verifier in plain text after a full connect`; `opens a sealed record only for its own Owner and Connection`; `opens a record that an older key sealed after a rotation`; `keeps the old refresh token when a refresh brings no new one` |
| `mcp-token-refresh.test.ts` | `refreshes before the call when the stored token is about to expire`; `keeps the old refresh token when the response has no new one`; `reads an old sealed client record with no token endpoint and moves to needs sign-in at the next refresh`; `refreshes stored tokens before an Operator add connects` |

"Behavior" means that the library with the wiring of the spike does not keep a rule. More Billy code can close some of these gaps. The 23 tests, by cause:

| Cause | Tests |
| --- | --- |
| No replay of a good callback (5) | `refuses the replay of an earlier attempt after a later one saved new tokens`; `settles with the first tokens and makes no second Connection`; `finishes with the saved tokens when the first connect failed`; `lets a replay deliver the completion when the hub stopped after it recorded the Connection`; `ends ready when the completion committed and its result was lost` |
| One connection object for each server id (3) | `does not deliver the completion of an earlier attempt after a later attempt exchanged its code`; `connects a second authorization with its own tokens after the completion failed once`; `does not let a second start overwrite ready after the first callback completed` |
| `iss` handling (2) | `refuses a wrong iss and keeps the request for the good callback`; `does not share a running callback with one that has a wrong iss` |
| The result is only a flag and a text (2) | `marks the Connection failed when the token endpoint refuses the code`; `logs the phase and the HTTP status of a refused code, with no secret` |
| Client authentication (1) | `refuses a registration that needs an unsupported client authentication method` |
| Case of the challenge parameter (2) | `follows the resource_metadata challenge to a tenant issuer`; `posts the code to the token endpoint of a tenant issuer` |
| No single flight and no queue (3) | `makes one token request for two calls that both need a refresh`; `retries a call that the server rejected with the old token after a reconnect that was still exchanging its code`; `makes an Operator add wait for a refresh that is running` |
| Errors do not name the cause (4) | `ends in needs sign-in when a rotated refresh token was lost after the provider accepted it`; `keeps the Connection ready when the token endpoint is down`; `moves to needs sign-in on invalid_grant, writes the Journal Entry, and keeps no secret`; `fails a call that needs more scope, makes no background sign-in, and moves to needs sign-in` |
| A replay reports success (1) | `does not let a replay of the first callback bring back ready after the tokens were deleted`: the replay set the state `ready` again after the tokens were deleted |

## Lines that a replacement removes

This is an estimate by function from the code. No replacement was built.

| File in `apps/agent/src/mcp` | Lines | Removed | What stays |
| --- | --- | --- | --- |
| `oauth-discovery.ts` | 228 | 118 | Client mode, PKCE and address checks, consent page data |
| `oauth-start.ts` | 187 | 131 | Pending request with the Owner Id, the `iss` rule, and the expiry |
| `oauth-token-exchange.ts` | 128 | 83 | Account label, error type |
| `oauth-token-refresh.ts` | 113 | 91 | Which refusal is final |
| `mcp-code-exchange.ts` | 114 | 35 | `settled` marker, latest exchange |
| `mcp-authorized-fetch.ts` | 138 | 72 | Deadline, `needs sign-in` mapping |
| `mcp-connection-health.ts` | 236 | 40 | Queue, state machine |
| `mcp-oauth-starter.ts` | 226 | 20 | Owner proof, queue, states |
| `mcp-oauth-completer.ts` | 209 | 20 | `iss` check before the library, replay, queue |
| `sealed-oauth-provider.ts` | 96 | 96 | Nothing |
| `sealed-credentials.ts` | 169 | 75 | Records that the revocation reads |
| `oauth-client-authentication.ts` | 23 | 0 | Revocation uses it |
| `oauth-token-revocation.ts` | 68 | 0 | All |
| `oauth-deadline.ts` | 13 | 0 | All |
| Total | 1,948 | about 780 |  |

New code, about 300 lines: the adapter (about 70), a provider subclass for the state format and the failure signals (about 50), a fetch function with the deadline, the status, and the account label (about 60), single flight and a durable guard in front of the callback (about 80), and a one-time move of the stored records (about 40). The net result is about 480 fewer lines, and the harder part of the code stays.

## Replace a part

The packages also export the single steps with no state: discovery, registration, the authorization URL, the exchange, and the refresh. Billy could call them from its own queue, with its own records. This avoids reasons 1 to 5. It was not tested, so this research does not recommend it. The cost to check first: a direct dependency on `@modelcontextprotocol/client`, and new code in Billy for the Bearer check, the PKCE S256 requirement, the account label, the HTTP status in the logs, and the deadline.

## The adapter and the tests in the tree

The adapter passes `pnpm verify` with no use in production, so it stays, as #250 asks. Delete it, the two test files, and the test host if nobody wants to watch the library.

## Revisit if

- The library joins refresh calls, or gives a hook that can hold them.
- The manager checks `iss` before it uses up the state, and refuses a second callback from a stored record.
- The library gives a different error when the token endpoint is down.
- The manager gets a switch for the restore on wake.
- A server needs an OAuth feature that is much work to write by hand, for example DPoP.
