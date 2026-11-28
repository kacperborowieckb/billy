import type { McpCatalogEntry } from "./mcp-catalog.ts";

export const testMcpCatalogId = "test_server";

export const testMcpCatalogEntry = (serverUrl: string): McpCatalogEntry => ({
  catalogId: testMcpCatalogId,
  displayName: "Test server",
  description: "A test-only MCP server with fake pages.",
  serverUrl,
  tools: [
    {
      name: "search",
      fingerprint: "M3m6BoBW9-9-dk9nj7FDKHIBJuu7bZXH_KS5_Px4WPc",
      riskClass: "read",
      resultIds: { field: "id", shape: { _tag: "Uuid" } },
    },
    {
      name: "fetch",
      fingerprint: "xMHAAHKI4ndzJfPdkw8LnMBabO_YFYnJhv82UnlaZ5A",
      riskClass: "read",
    },
    {
      name: "big_dump",
      fingerprint: "ylgQuV4h-PHtzSCKfqSc_0H1yFHXD5dymggFvJGCasM",
      riskClass: "read",
    },
    {
      name: "slow_read",
      fingerprint: "6otMN3Wx4ZaWY6i5VebqVG5YzXPrj5qQg7wNvodlpoE",
      riskClass: "read",
    },
    {
      name: "failing_read",
      fingerprint: "N_tt5c_o6IQLLFIbR3jtgMjetjOMH4UWwH5XZCcOXaw",
      riskClass: "read",
    },
    {
      name: "poisoned_read",
      fingerprint: "9XpLBnLs2Johlvh2jGeKpY6B0P0UDJKRjuVkJIcoM3s",
      riskClass: "read",
    },
    {
      name: "archive_page",
      fingerprint: "0BnTaquk3cqU_f3PgNkLkwAC9l1VacNV8hlhM-wf2Fo",
      riskClass: "read",
      summary: "archive page {id}",
    },
    {
      name: "create_page",
      fingerprint: "g0iB4LPZMqry8Y-dJXYjvHDBa-8nQ4YysXiegPRmjD4",
      riskClass: "approve",
      summary: "create page {title}",
    },
    {
      name: "rename_page",
      fingerprint: "EjD2DWljae3jFEmMM7ZnSRWom36d8-_XedlI8X8LFkE",
      riskClass: "change",
      summary: "rename page {id} to {title}",
    },
    {
      name: "slow_write",
      fingerprint: "INJqVbXvksu0qbc29fEDXxSywVEmWmI2udiHgiZRHIE",
      riskClass: "approve",
      summary: "write page {title}",
    },
    {
      name: "failing_write",
      fingerprint: "TyhFQYiQaxsLQRyxCj8hiR0umc302vPbNaM2ibAjyB4",
      riskClass: "approve",
      summary: "write a failing page",
    },
    {
      name: "wipe_workspace",
      fingerprint: "k0KQKV82KQ7XwDR843HIBzB_pw0BEns4n8HPSicHVWU",
      riskClass: "blocked",
    },
  ],
});
