export const allowedOriginsOf = (env: Env): readonly string[] =>
  env.MCP_TEST_SERVER_URL === ""
    ? []
    : [new URL(env.MCP_TEST_SERVER_URL).origin];
