/** Configuration model for agent-dingtalk.config.jsonc. */

/** Backend names accepted by runtime modules. */
export type AgentBackend = "claude-code" | "opencode";

/** Claude Code SDK permission modes accepted by configuration. */
export const CLAUDE_CODE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

/** Claude Code SDK permission mode accepted by configuration. */
export type ClaudeCodePermissionMode = (typeof CLAUDE_CODE_PERMISSION_MODES)[number];

/** Output renderer modes accepted by configuration. */
export type OutputMode = "markdown";

/** Default per-file download limit used when security.maxDownloadFileBytes is omitted. */
export const DEFAULT_MAX_DOWNLOAD_FILE_BYTES = 20 * 1024 * 1024;

/** Agent execution environment shared by the default context and named projects. */
export interface AgentEnvironmentConfig {
  backend: AgentBackend;
  cwd: string;
  agent?: string;
  model?: string;
}

/** Optional named project users can open without retyping all environment settings. */
export interface ProjectConfig extends AgentEnvironmentConfig {
  name: string;
}

/** DingTalk Stream Mode and authorization settings. */
export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  allowedUserIds: string[];
  rejectGroupMessages: boolean;
}

/** Filesystem allowlist used before opening local Agent working directories. */
export interface SecurityConfig {
  allowedRootDirs: string[];
  downloadAllowedDirs: string[];
  maxDownloadFileBytes: number;
}

/** Claude Code backend defaults passed to the Claude Agent SDK adapter. */
export interface ClaudeCodeConfig {
  permissionMode?: ClaudeCodePermissionMode;
  allowedTools?: string[];
  maxTurns: number;
}

/** DingTalk reply rendering behavior. */
export interface OutputConfig {
  mode: OutputMode;
  maxMessageChars: number;
}

/** Fully validated application configuration used by runtime modules. */
export interface AppConfig {
  dingtalk: DingTalkConfig;
  defaultEnvironment: AgentEnvironmentConfig;
  projects?: ProjectConfig[];
  security: SecurityConfig;
  claudeCode: ClaudeCodeConfig;
  output: OutputConfig;
}
