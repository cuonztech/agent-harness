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
  write_tool_patterns: z
    .array(z.string())
    .optional()
    .describe(
      'Glob patterns ("*" wildcard) deciding which tool names count as writes for ' +
        'scenario triggering and scoring, e.g. ["create_*", "send_*", "book_*"]. ' +
        "Replaces the default list of common write-verb prefixes (write*, create_*, send_*, " +
        "submit_*, post_*, update_*, book_*, pay_*, charge_*, transfer_*, refund_*, ...). " +
        "A tool that matches " +
        "neither a write pattern nor a read pattern is reported as unclassified and not scored.",
    ),
  read_tool_patterns: z
    .array(z.string())
    .optional()
    .describe(
      'Extra glob patterns counted as reads, on top of the built-in read prefixes ' +
        "(read, get, list, check, verify, query, fetch, inspect, status, search, find, " +
        "lookup, describe, show, count, view, retrieve).",
    ),
  key_fields: z
    .array(z.string())
    .optional()
    .describe(
      'Argument names that carry an idempotency key (default ["idempotency_key"]; matched ' +
        'case-insensitively, ignoring "-" and "_"). They are ignored when two write calls ' +
        "are compared, so the same write re-sent under a new key still counts as the same operation.",
    ),
  retry_after_sec: z
    .number()
    .positive()
    .optional()
    .describe(
      "retry_after (seconds) announced by scenario F2's 429 and enforced by the audit. Default 60.",
    ),
};

export const ExecuteCallSchema = {
  session_id: z.string().uuid().describe("Active session ID (the UUID returned by start_session)."),
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
  session_id: z.string().uuid().describe("Session ID to audit (the UUID returned by start_session)."),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("markdown")
    .describe("Output format: markdown (default) or json."),
};

export const GetScoreSchema = {
  session_id: z.string().uuid().describe("Session ID to score (the UUID returned by start_session)."),
  format: z
    .enum(["json", "markdown"])
    .optional()
    .default("markdown")
    .describe("Output format: markdown (default) or json."),
};

export const ListScenariosSchema = {};

export const ResetSessionSchema = {
  session_id: z.string().uuid().describe("Session ID to reset (the UUID returned by start_session)."),
};

export const DeleteSessionSchema = {
  session_id: z.string().uuid().describe("Session ID to delete (the UUID returned by start_session)."),
};