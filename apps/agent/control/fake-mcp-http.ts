import { once } from "node:events";
import { createServer } from "node:http";

import { Effect } from "effect";

import { createFakeMcpServer } from "./fake-mcp-server.ts";

const readRequestBody = async (request: AsyncIterable<Buffer | string>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const startFakeMcpServer = Effect.fnUntraced(
  function* startFakeMcpServer() {
    const fake = createFakeMcpServer();
    const server = createServer(async (request, response) => {
      const body = await readRequestBody(request);
      const answer = await fake.fetch(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([name, value]) =>
              typeof value === "string" ? [[name, value]] : []
            )
          ),
          ...(request.method === "POST" ? { body } : {}),
        })
      );
      response.writeHead(
        answer.status,
        Object.fromEntries(answer.headers.entries())
      );
      response.end(Buffer.from(await answer.arrayBuffer()));
    });
    const port = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (typeof address !== "object" || address === null) {
          throw new Error("The fake MCP server has no port");
        }
        return address.port;
      }),
      () =>
        Effect.promise(async () => {
          server.close();
          await once(server, "close");
        })
    );
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      calls: () => fake.calls.map((call) => call.tool),
    };
  }
);
