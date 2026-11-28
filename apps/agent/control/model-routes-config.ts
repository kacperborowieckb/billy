import { Schema } from "effect";
import { experimental_readRawConfig } from "wrangler";

import { ModelRouteTableSchema } from "../src/model-gateway/model-routes.ts";
import { wranglerConfigPath } from "./workspace.ts";

export const configuredModelRoutes = () =>
  Schema.decodeUnknownSync(ModelRouteTableSchema)(
    experimental_readRawConfig({ config: wranglerConfigPath }).rawConfig.vars?.[
      "MODEL_ROUTES"
    ]
  );
