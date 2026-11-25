import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: [
    "./src/personal-agent/storage-schema.ts",
    "./src/personal-agent/turn-progress-schema.ts",
    "./src/personal-agent/prefix-cache-schema.ts",
    "./src/preferences/preferences-schema.ts",
    "./src/proactive/proactive-schema.ts",
    "./src/schedule/schedule-open-loops-schema.ts",
    "./src/approval/pending-approvals-schema.ts",
  ],
  out: "./src/personal-agent/migrations",
});
