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
  waitForStop?: boolean;
  stoppedMessage?: string;
  stopDrainDelayMs?: number;
  stopError?: unknown;
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
  private readonly waitForStop: boolean;
  private readonly stoppedMessage: string;
  private readonly stopDrainDelayMs: number;
  private readonly stopError: unknown;
  private stopRequested = false;
  private stopWaiters: Array<() => void> = [];

  public constructor(options: FakeBackendAdapterOptions = {}) {
    this.text = options.text ?? DEFAULT_TEXT_EVENT;
    this.result = options.result ?? DEFAULT_DONE_RESULT;
    this.sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
    this.waitForStop = options.waitForStop ?? false;
    this.stoppedMessage = options.stoppedMessage ?? "当前 Agent 任务已中断。";
    this.stopDrainDelayMs = options.stopDrainDelayMs ?? 0;
    this.stopError = options.stopError;
  }

  /** Opens a fake backend session for the selected environment. */
  public open(environment: AgentEnvironment): BackendSession {
    this.stopRequested = false;
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

    if (this.waitForStop) {
      await this.waitUntilStopped();
      await delay(this.stopDrainDelayMs);
      yield { type: "stopped", message: this.stoppedMessage, sessionId: this.sessionId };
      return;
    }

    yield { type: "done", result: this.result, sessionId: this.sessionId };
  }

  /** Records fake stop requests without changing the deterministic stream. */
  public stop(session: BackendSession): void {
    this.stops.push(session);

    if (this.stopError !== undefined) {
      this.stopRequested = true;
      this.resolveStopWaiters();
      throw this.stopError;
    }

    this.stopRequested = true;
    this.resolveStopWaiters();
  }

  /** Records fake close requests for lifecycle assertions. */
  public close(session: BackendSession): void {
    this.closes.push(session);
    this.resolveStopWaiters();
  }

  /** Resolves when a fake long-running stream receives a stop request. */
  private waitUntilStopped(): Promise<void> {
    if (this.stopRequested) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
    });
  }

  /** Releases all pending fake stream waiters. */
  private resolveStopWaiters(): void {
    const waiters = this.stopWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

/** Waits for a bounded fake drain delay after stop is requested. */
function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
