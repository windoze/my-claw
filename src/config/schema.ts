/** Zod schemas that validate and normalize agent-dingtalk.config.jsonc. */

import { z } from "zod";

import { CLAUDE_CODE_PERMISSION_MODES } from "./types.js";

/** Shared non-empty string rule for required configuration text fields. */
const nonEmptyStringSchema = z.string().min(1, "must not be empty");

/** Runtime backend names accepted in the first phase. */
const agentBackendSchema = z.literal("claude-code");

/** Output formats accepted by the current DingTalk reply renderer. */
const outputModeSchema = z.literal("markdown");

/** Validates an agent execution environment block. */
export const agentEnvironmentConfigSchema = z
  .object({
    backend: agentBackendSchema,
    cwd: nonEmptyStringSchema,
    agent: nonEmptyStringSchema.optional(),
    model: nonEmptyStringSchema.optional(),
  })
  .strict();

/** Validates a named project environment block. */
export const projectConfigSchema = agentEnvironmentConfigSchema
  .extend({
    name: nonEmptyStringSchema,
  })
  .strict();

/** Validates DingTalk credentials and message authorization settings. */
export const dingtalkConfigSchema = z
  .object({
    clientId: nonEmptyStringSchema,
    clientSecret: nonEmptyStringSchema,
    robotCode: nonEmptyStringSchema.optional(),
    allowedUserIds: z
      .array(nonEmptyStringSchema)
      .min(1, "must contain at least one allowed DingTalk user id"),
    rejectGroupMessages: z.boolean().default(true),
  })
  .strict();

/** Validates filesystem security settings used before opening work directories. */
export const securityConfigSchema = z
  .object({
    allowedRootDirs: z
      .array(nonEmptyStringSchema)
      .min(1, "must contain at least one allowed root directory"),
  })
  .strict();

/** Validates Claude Code backend behavior defaults. */
export const claudeCodeConfigSchema = z
  .object({
    permissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
    allowedTools: z.array(nonEmptyStringSchema).optional(),
    maxTurns: z.number().int().positive().default(20),
  })
  .strict();

/** Validates DingTalk output behavior and fills safe defaults. */
export const outputConfigSchema = z
  .object({
    mode: outputModeSchema,
    maxMessageChars: z.number().int().positive().default(18000),
  })
  .strict();

/** Validates the complete application configuration. */
export const appConfigSchema = z
  .object({
    dingtalk: dingtalkConfigSchema,
    defaultEnvironment: agentEnvironmentConfigSchema,
    projects: z.array(projectConfigSchema).optional(),
    security: securityConfigSchema,
    claudeCode: claudeCodeConfigSchema,
    output: outputConfigSchema,
  })
  .strict();
