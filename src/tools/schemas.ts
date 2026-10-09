import { z } from "zod";

export const StartSessionSchema = {
  scenario_id: z
    .string()
    .optional()
    .describe(
      "Scenario ID to activate (F1–F5). Omit for ad-hoc mode.",
    ),
  mode: z
    .enum(["deterministic", "chaos"])
    .optional()
    .default("deterministic")
    .describe("Test mode: deterministic (default) or stochastic chaos."),
  error_rate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.0)
    .describe("Chaos mode only: probability of random error injection (0.0–1.0)."),
};

export const ExecuteCallSchema = {
  session_id: z.string().uuid().describe("Active session ID."),
  tool_name: z.string().describe("Name of the tool the agent is calling."),
  arguments: z
    .record(z.string(), z.unknown())
    .describe("Arguments the agent passes to the tool."),
  idempotency_key: z
    .string()
    .optional()
    .describe("Idempotency key for duplicate detection."),
};

export const GetReportSchema = {
  session_id: z.string().uuid().describe("Session ID to audit."),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("markdown")
    .describe("Output format: markdown (default) or json."),
};

export const GetScoreSchema = {
  session_id: z.string().uuid().describe("Session ID to score."),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("markdown")
    .describe("Output format: markdown (default) or json."),
};

export const ListScenariosSchema = {};

export const ResetSessionSchema = {
  session_id: z.string().uuid().describe("Session ID to reset."),
};

export const DeleteSessionSchema = {
  session_id: z.string().uuid().describe("Session ID to delete."),
};