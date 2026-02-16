import { createMiddleware } from "hono/factory";
import type { HonoEnv } from "../types";

export const requireOpenAIKey = createMiddleware<HonoEnv>(
  async (c, next) => {
    if (!c.env.OPENAI_API_KEY) {
      return c.json(
        { error: "OpenAI API key not configured. Add it with: npx wrangler secret put OPENAI_API_KEY" },
        500
      );
    }
    await next();
  }
);
