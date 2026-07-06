/** Deterministic backend adapter for local integration checks without Claude Code. */

import type { AgentEvent, AgentInput, BackendAdapter, BackendSession } from "../backend/types.js";
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
export interface FakeBackendOpenCall {
  environment: AgentEnvironment;
  session: BackendSession;
}

/** Recorded fake backend send call for assertions and manual inspection. */
export interface FakeBackendSendCall {
  input: AgentInput;
  session: BackendSession;
}

/** Backend test double that records sends and returns fixed text/done events. */
export class FakeBackendAdapter implements BackendAdapter {
  public readonly opens: FakeBackendOpenCall[] = [];
  public readonly sends: FakeBackendSendCall[] = [];
  public readonly stops: BackendSession[] = [];
  public readonly closes: BackendSession[] = [];

  private readonly text: string;
  private readonly result: string;
  private readonly sessionId: string;

  public constructor(options: FakeBackendAdapterOptions = {}) {
    this.text = options.text ?? DEFAULT_TEXT_EVENT;
    this.result = options.result ?? DEFAULT_DONE_RESULT;
    this.sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  }

  /** Opens a fake backend session for the selected environment. */
  public open(environment: AgentEnvironment): BackendSession {
    const session: BackendSession = {
      backend: environment.backend,
      cwd: environment.cwd,
      sessionId: environment.sessionId ?? this.sessionId,
      raw: { environment },
    };

    this.opens.push({ environment, session });
    return session;
  }

  /** Records the request and yields deterministic Agent events. */
  public async *send(session: BackendSession, input: AgentInput): AsyncIterable<AgentEvent> {
    this.sends.push({ input, session });

    yield { type: "text", text: this.text };
    yield { type: "done", result: this.result, sessionId: this.sessionId };
  }

  /** Records fake stop requests without changing the deterministic stream. */
  public stop(session: BackendSession): void {
    this.stops.push(session);
  }

  /** Records fake close requests for lifecycle assertions. */
  public close(session: BackendSession): void {
    this.closes.push(session);
  }
}
