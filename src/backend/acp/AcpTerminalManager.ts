/** ACP `terminal/*` client-method implementation backed by child processes. */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

import { UserFacingError } from "../../utils/errors.js";
import { createLogger, type Logger } from "../../utils/logger.js";

/** Exit status recorded once a terminal command completes. */
interface TerminalExit {
  exitCode: number | null;
  signal: string | null;
}

/** One tracked terminal: its child process, buffered output, and exit state. */
interface AcpTerminal {
  id: string;
  child: ChildProcess;
  outputByteLimit: number | null;
  output: string;
  truncated: boolean;
  exit: TerminalExit | null;
  exitWaiters: ((exit: TerminalExit) => void)[];
}

/** Options for constructing a terminal manager bound to one session directory. */
export interface AcpTerminalManagerOptions {
  sessionCwd: string;
  logger?: Logger;
}

/**
 * Implements the ACP `terminal/*` client methods by spawning child processes.
 *
 * Commands run silently in the session working directory (a trusted-provider
 * model matching how the native CLI runs commands itself); no per-command
 * authorization prompt is raised. Output is buffered and truncated from the
 * front to respect `outputByteLimit`.
 */
export class AcpTerminalManager {
  private readonly sessionCwd: string;
  private readonly logger: Logger;
  private readonly terminals = new Map<string, AcpTerminal>();

  public constructor(options: AcpTerminalManagerOptions) {
    this.sessionCwd = options.sessionCwd;
    this.logger = options.logger ?? createLogger("backend:acp:terminal");
  }

  /** Spawns a command and returns its terminal id for later output/exit queries. */
  public create(params: CreateTerminalRequest): CreateTerminalResponse {
    const id = `term_${randomUUID()}`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of params.env ?? []) {
      env[variable.name] = variable.value;
    }

    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? this.sessionCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminal: AcpTerminal = {
      id,
      child,
      outputByteLimit: params.outputByteLimit ?? null,
      output: "",
      truncated: false,
      exit: null,
      exitWaiters: [],
    };
    this.terminals.set(id, terminal);

    const append = (chunk: Buffer): void => {
      terminal.output += chunk.toString("utf8");
      const limit = terminal.outputByteLimit;
      if (limit !== null && terminal.output.length > limit) {
        terminal.output = terminal.output.slice(terminal.output.length - limit);
        terminal.truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (error) => {
      this.logger.error("ACP terminal process error.", { error, terminalId: id });
      terminal.output += `\n[terminal error] ${String(error)}`;
    });
    child.on("exit", (code, signal) => {
      const exit: TerminalExit = { exitCode: code, signal: signal ?? null };
      terminal.exit = exit;
      for (const waiter of terminal.exitWaiters.splice(0)) {
        waiter(exit);
      }
    });

    return { terminalId: id };
  }

  /** Returns buffered output and, if the command has exited, its status. */
  public output(params: TerminalOutputRequest): TerminalOutputResponse {
    const terminal = this.require(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exit !== null
        ? { exitStatus: { exitCode: terminal.exit.exitCode, signal: terminal.exit.signal } }
        : {}),
    };
  }

  /** Resolves once the command exits, returning its exit code/signal. */
  public async waitForExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.require(params.terminalId);
    const exit = terminal.exit ?? (await new Promise<TerminalExit>((resolve) => {
      terminal.exitWaiters.push(resolve);
    }));
    return { exitCode: exit.exitCode, signal: exit.signal };
  }

  /** Kills the command but keeps the terminal so output can still be read. */
  public kill(params: KillTerminalRequest): KillTerminalResponse {
    const terminal = this.require(params.terminalId);
    if (terminal.exit === null) {
      terminal.child.kill();
    }
    return {};
  }

  /** Kills the command (if running) and drops all terminal bookkeeping. */
  public release(params: ReleaseTerminalRequest): ReleaseTerminalResponse {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal !== undefined) {
      if (terminal.exit === null) {
        terminal.child.kill();
      }
      this.terminals.delete(params.terminalId);
    }
    return {};
  }

  /** Kills every tracked terminal; used on connection teardown. */
  public disposeAll(): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.exit === null) {
        terminal.child.kill();
      }
    }
    this.terminals.clear();
  }

  /** Resolves a terminal id or throws a user-safe error. */
  private require(terminalId: string): AcpTerminal {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) {
      throw new UserFacingError("ACP_TERMINAL_NOT_FOUND", `未知的终端：${terminalId}`);
    }

    return terminal;
  }
}
