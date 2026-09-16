import { z } from "zod";
import "dotenv/config";

const Env = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().default(8080),
  DEMO_AUTH_TOKEN: z.string().default("demo-secret"),
  MODEL_API_KEY: z.string().optional(),
  MODEL_BASE_URL: z.string().default("https://api.deepseek.com/anthropic"),
  MODEL_NAME: z.string().default("deepseek-v4-flash"),
  DEMO_BUDGET_USD: z.coerce.number().default(0.5),
  FRESHNESS_THRESHOLD_DAYS: z.coerce.number().default(60),
});

export const config = Env.parse(process.env);
