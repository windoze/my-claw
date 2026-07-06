/** Markdown renderer for sanitized SessionManager state summaries. */

import type {
  RuntimeTaskSummary,
  SessionEnvironmentSummary,
  SessionStateSummary,
} from "../session/SessionManager.js";

const EMPTY_VALUE = "无";

/** Formats a sanitized session state snapshot for a DingTalk Markdown reply. */
export function formatState(summary: SessionStateSummary): string {
  const lines = [
    "### 当前状态",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    row("运行状态", formatRuntimeStatus(summary.runtime.status)),
    row("当前环境", formatEnvironmentKind(summary.currentEnvironment.kind)),
    row("当前目录", summary.currentEnvironment.cwd),
    row("后端", summary.currentEnvironment.backend),
    row("Agent", summary.currentEnvironment.agent ?? EMPTY_VALUE),
    row("Model", summary.currentEnvironment.model ?? EMPTY_VALUE),
    row("Session", formatSessionId(summary.currentEnvironment.sessionId)),
    row("可接收普通消息", summary.canAcceptNormalMessage ? "是" : "否"),
    "",
    "#### 运行任务",
    "",
    ...formatRuntimeTask(summary.runtime.currentTask),
    "",
    "#### 默认环境",
    "",
    ...formatEnvironment(summary.defaultEnvironment),
    "",
    "#### 当前项目",
    "",
    ...(summary.activeProject === null ? [EMPTY_VALUE] : formatEnvironment(summary.activeProject)),
    "",
    "#### 已知项目",
    "",
    ...formatKnownProjects(summary.knownProjects),
  ];

  return lines.join("\n");
}

/** Formats a single environment summary as a two-column Markdown table. */
function formatEnvironment(environment: SessionEnvironmentSummary): string[] {
  return [
    "| 项目 | 值 |",
    "| --- | --- |",
    row("类型", formatEnvironmentKind(environment.kind)),
    row("目录", environment.cwd),
    row("后端", environment.backend),
    row("Agent", environment.agent ?? EMPTY_VALUE),
    row("Model", environment.model ?? EMPTY_VALUE),
    row("Session", formatSessionId(environment.sessionId)),
  ];
}

/** Formats the current runtime task or a clear empty marker. */
function formatRuntimeTask(task: RuntimeTaskSummary | null): string[] {
  if (task === null) {
    return [EMPTY_VALUE];
  }

  return [
    "| 项目 | 值 |",
    "| --- | --- |",
    row("后端", task.backend),
    row("目录", task.cwd),
    row("消息 ID", task.messageId ?? EMPTY_VALUE),
    row("开始时间", task.startedAt ?? EMPTY_VALUE),
  ];
}

/** Formats retained project summaries without exposing raw configuration. */
function formatKnownProjects(projects: readonly SessionEnvironmentSummary[]): string[] {
  if (projects.length === 0) {
    return [EMPTY_VALUE];
  }

  return [
    "| 目录 | 后端 | Session |",
    "| --- | --- | --- |",
    ...projects.map((project) =>
      [
        escapeMarkdownTableCell(project.cwd),
        escapeMarkdownTableCell(project.backend),
        escapeMarkdownTableCell(formatSessionId(project.sessionId)),
      ].join(" | "),
    ).map((line) => `| ${line} |`),
  ];
}

/** Formats a Markdown table row while escaping user-controlled cells. */
function row(label: string, value: string): string {
  return `| ${escapeMarkdownTableCell(label)} | ${escapeMarkdownTableCell(value)} |`;
}

/** Renders stable runtime status labels with the persisted enum for debugging clarity. */
function formatRuntimeStatus(status: SessionStateSummary["runtime"]["status"]): string {
  switch (status) {
    case "idle":
      return "空闲 (idle)";
    case "running":
      return "运行中 (running)";
    case "stopping":
      return "中断中 (stopping)";
  }
}

/** Renders stable environment kind labels with the persisted enum for debugging clarity. */
function formatEnvironmentKind(kind: SessionEnvironmentSummary["kind"]): string {
  switch (kind) {
    case "default":
      return "默认环境 (default)";
    case "project":
      return "项目环境 (project)";
  }
}

/** Ensures raw session ids are shortened if an unsanitized value reaches the renderer. */
function formatSessionId(sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) {
    return EMPTY_VALUE;
  }

  if (sessionId.includes("...")) {
    return sessionId;
  }

  if (sessionId.length <= 12) {
    return `${sessionId.slice(0, 4)}...`;
  }

  return `${sessionId.slice(0, 8)}...${sessionId.slice(-4)}`;
}

/** Escapes characters that would break Markdown tables. */
function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
