/** Centralized ACP session/update-to-AgentEvent mapping. */

import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";

import type { AgentEvent } from "../types.js";

/** The `update` payload carried by an ACP `session/update` notification. */
type SessionUpdate = SessionNotification["update"];

/** Tracks tool calls reported as started (id → display name) for finish pairing. */
export interface AcpUpdateMappingState {
  startedToolCalls: Map<string, string>;
}

/** Creates update mapping state for one ACP prompt turn. */
export function createAcpUpdateMappingState(): AcpUpdateMappingState {
  return { startedToolCalls: new Map<string, string>() };
}

/** Maps one ACP session update to a backend-neutral AgentEvent, or null when ignored. */
export function mapAcpUpdate(
  update: SessionUpdate,
  state: AcpUpdateMappingState,
): AgentEvent | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = extractContentText(update.content);
      return text.length > 0 ? { type: "text", text } : null;
    }
    case "agent_thought_chunk": {
      const text = extractContentText(update.content);
      return text.length > 0 ? { type: "thought", text } : null;
    }
    case "tool_call": {
      if (state.startedToolCalls.has(update.toolCallId)) {
        return null;
      }

      state.startedToolCalls.set(update.toolCallId, update.title);
      return {
        type: "tool_start",
        name: update.title,
        title: update.title,
        ...(update.kind !== undefined ? { kind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
      };
    }
    case "tool_call_update": {
      // Some agents (e.g. claude-agent-acp) stream title/content updates without a
      // terminal status; only completed/failed close the call here. Any still-open
      // call is flushed by drainUnfinishedToolCalls when the turn ends.
      if (update.status !== "completed" && update.status !== "failed") {
        return null;
      }

      const name = state.startedToolCalls.get(update.toolCallId);
      if (name === undefined) {
        return null;
      }

      state.startedToolCalls.delete(update.toolCallId);
      return { type: "tool_finish", name: update.title ?? name, status: update.status };
    }
    case "plan": {
      return {
        type: "plan",
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
          ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
        })),
      };
    }
    default:
      // available_commands_update / current_mode_update / user_message_chunk
      // carry no user-visible output today.
      return null;
  }
}

/**
 * Emits a `tool_finish` for every tool call still open when a prompt turn ends.
 * Agents are not required to send a terminal `tool_call_update`, so this pairs
 * any dangling `tool_start` and clears the state.
 */
export function drainUnfinishedToolCalls(state: AcpUpdateMappingState): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const name of state.startedToolCalls.values()) {
    events.push({ type: "tool_finish", name, status: "completed" });
  }

  state.startedToolCalls.clear();
  return events;
}

/** Concatenates the text of a text content block; other block types yield "". */
export function extractContentText(content: ContentBlock): string {
  return content.type === "text" ? content.text : "";
}
