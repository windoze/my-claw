/** Deterministic backend adapter for local integration checks without Claude Code. */

import type { AgentEvent, AgentInput } from "../backend/types.js";
import type { AgentEnvironment } from "../session/types.js";

const DEFAULT_TEXT_EVENT = "Fake backend response.";
const DEFAULT_DONE_RESULT = "Fake backend completed.";
const DEFAULT_SESSION_ID = "fake-session-id";

/** Options that customize the fixed fake backend event stream. */
export interface FakeBackendAdapterOptions {
  text?: string;
  result?: string;
  sessionId?: string;
}

/** Recorded fake backend request for assertions and manual inspection. */
export interface FakeBackendSendCall {
  input: AgentInput;
  environment: AgentEnvironment;
}

/** Backend test double that records sends and returns fixed text/done events. */
export class FakeBackendAdapter {
  public readonly sends: FakeBackendSendCall[] = [];

  private readonly text: string;
  private readonly result: string;
  private readonly sessionId: string;

  public constructor(options: FakeBackendAdapterOptions = {}) {
    this.text = options.text ?? DEFAULT_TEXT_EVENT;
    this.result = options.result ?? DEFAULT_DONE_RESULT;
    this.sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  }

  /** Records the request and returns deterministic Agent events. */
  public async send(input: AgentInput, environment: AgentEnvironment): Promise<AgentEvent[]> {
    this.sends.push({ input, environment });

    return [
      { type: "text", text: this.text },
      { type: "done", result: this.result, sessionId: this.sessionId },
    ];
  }
}
