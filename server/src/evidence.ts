import { config } from "./config.js";

export const TIME_SENSITIVE_FIELDS = ["employee_count", "buying_intent", "tech_stack"];

export const isStale = (retrievedAt: Date, field: string) =>
  TIME_SENSITIVE_FIELDS.includes(field) &&
  (Date.now() - retrievedAt.getTime()) / 86400_000 > config.FRESHNESS_THRESHOLD_DAYS;
