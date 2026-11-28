import { Schema } from "effect";

import { modelTasks } from "../personal-agent/storage-values.ts";
import { ReasoningEffortSchema } from "./model-provider.ts";
import type { ModelTask } from "./model-provider.ts";

const ModelRouteSchema = Schema.Struct({
  model: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reasoningEffort: ReasoningEffortSchema,
});

export type ModelRoute = typeof ModelRouteSchema.Type;

const RouteNameSchema = Schema.Literals(["primary", "secondary", "reviewer"]);

export const ModelRouteTableSchema = Schema.Struct({
  primary: ModelRouteSchema,
  secondary: ModelRouteSchema,
  reviewer: ModelRouteSchema,
  tasks: Schema.Record(Schema.Literals(modelTasks), RouteNameSchema),
});

export type ModelRouteTable = typeof ModelRouteTableSchema.Type;

export const routeOf = (table: ModelRouteTable, task: ModelTask): ModelRoute =>
  table[table.tasks[task]];
