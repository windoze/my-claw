/** Shared prompt formatting for backend adapters that do not take native attachments yet. */

import type { AgentInput } from "./types.js";

/** Appends local attachment paths and summaries to a text prompt for backend adapters. */
export function formatAgentInputPrompt(input: AgentInput): string {
  if (input.attachments === undefined || input.attachments.length === 0) {
    return input.text;
  }

  const userText = input.text.trim();
  const attachmentLines = input.attachments.map((attachment, index) => {
    const name = attachment.filename ?? "未命名附件";
    const mime = attachment.mime ?? "unknown";
    const size = attachment.size === undefined ? "unknown size" : `${attachment.size} bytes`;
    const localPath = attachment.localPath ?? "未下载到本地路径";
    return `${index + 1}. ${attachment.type}: ${name} (${mime}, ${size})\n   localPath: ${localPath}`;
  });
  const attachmentPrompt = [
    "用户随消息提供了以下本地临时附件。请按需读取 localPath 中的文件内容；这些路径会在清理周期后删除。",
    ...attachmentLines,
  ].join("\n");

  if (userText.length === 0) {
    return attachmentPrompt;
  }

  return `${userText}\n\n${attachmentPrompt}`;
}
