/** DingTalk Stream Mode adapter that maps robot callbacks into internal messages. */

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream-sdk-nodejs";

import { AppError, createLogger, type Logger } from "../utils/index.js";
import { DingTalkCardClient, DingTalkCardStreamer } from "./cards/index.js";
import { DingTalkFileClient, DingTalkReplySink } from "./DingTalkReplySink.js";
import { MessageDeduper, type MessageDeduperDecision } from "./MessageDeduper.js";
import {
  createConnectFailureLogContext,
  createConnectionLogContext,
  installStreamLifecycleLogging,
  type StreamLifecycleCleanup,
} from "./StreamLifecycleLogger.js";
import { createDingTalkCallbackLogSample, mapDingTalkRobotMessage } from "./mapMessage.js";
import type {
  DingTalkAdapterOptions,
  DingTalkMessageMappingWarning,
  DingTalkReplySinkFactory,
  DingTalkRobotCallback,
  DingTalkStreamClient,
  DingTalkStreamClientFactory,
  DingTalkStreamClientOptions,
} from "./types.js";

const DEFAULT_KEEP_ALIVE = true;
const DEFAULT_AUTO_RECONNECT = false;
const DEFAULT_USER_AGENT = "my-claw-dingtalk-agent";
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

interface DebuggableDingTalkStreamClient extends DingTalkStreamClient {
  debug?: boolean;
  connected?: boolean;
  onDownStream?: (data: string) => void;
  registered?: boolean;
}

/** Connects to DingTalk Stream Mode and forwards robot messages to the injected handler. */
export class DingTalkAdapter {
  private readonly config: DingTalkAdapterOptions["config"];
  private readonly handler: DingTalkAdapterOptions["handler"];
  private readonly createReplySink: DingTalkReplySinkFactory;
  private readonly fileClient: DingTalkFileClient;
  private readonly cardClient: DingTalkCardClient | undefined;
  private readonly client: DingTalkStreamClient;
  private readonly deduper: MessageDeduper;
  private readonly logger: Logger;
  private readonly topic: string;
  private readonly lifecycleCleanup: StreamLifecycleCleanup;
  private callbackRegistered = false;
  private connecting = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopping = false;

  public constructor(options: DingTalkAdapterOptions) {
    this.config = options.config;
    this.handler = options.handler;
    this.logger = options.logger ?? createLogger("dingtalk");
    this.fileClient = new DingTalkFileClient({
      config: this.config,
      logger: this.logger,
    });
    this.cardClient =
      options.streaming?.mode === "ai-card"
        ? new DingTalkCardClient({
            dingtalkConfig: this.config,
            streamingConfig: options.streaming,
            logger: this.logger,
          })
        : undefined;
    this.createReplySink =
      options.createReplySink ??
      ((context) =>
        new DingTalkReplySink({
          context,
          config: this.config,
          fileClient: this.fileClient,
          cardStreamer:
            this.cardClient === undefined
              ? undefined
              : new DingTalkCardStreamer({
                  context,
                  client: this.cardClient,
                }),
          logger: this.logger,
        }));
    this.topic = options.topic ?? TOPIC_ROBOT;
    this.client = this.createClient(options);
    this.deduper = options.deduper ?? new MessageDeduper({ logger: this.logger });
    patchSdkConsoleLeaks(this.client, this.logger);
    this.lifecycleCleanup = installStreamLifecycleLogging(this.client, this.logger, this.topic);
  }

  /** Registers the robot callback and opens the DingTalk Stream connection. */
  public async start(): Promise<void> {
    if (this.started) {
      this.logger.warn("DingTalk Stream adapter is already started.");
      return;
    }

    this.stopping = false;
    this.registerRobotCallback();

    try {
      this.logger.info(
        "Connecting DingTalk Stream adapter.",
        createConnectionLogContext(this.client, this.topic),
      );
      await this.connectClient();
      this.started = true;
      this.startHealthCheck();
      this.logger.info(
        "DingTalk Stream adapter started.",
        createConnectionLogContext(this.client, this.topic),
      );
    } catch (error: unknown) {
      this.logger.error(
        "DingTalk Stream connection failed; check DingTalk credentials and network connectivity.",
        createConnectFailureLogContext(error, this.client, this.topic),
      );
      throw new AppError(
        "DINGTALK_STREAM_CONNECT_FAILED",
        "Failed to connect DingTalk Stream. Check dingtalk.clientId/clientSecret and network connectivity.",
        {
          cause: error,
        },
      );
    }
  }

  /** Disconnects the Stream client if it was started. */
  public stop(): void {
    if (!this.started) {
      return;
    }

    this.stopping = true;
    this.clearReconnectTimer();
    this.stopHealthCheck();
    this.disconnectClient("stop");
    this.started = false;
    this.logger.info("DingTalk Stream adapter stopped.", { topic: this.topic });
  }

  /** Alias used by application shutdown code. */
  public close(): void {
    this.stop();
    this.lifecycleCleanup();
    this.deduper.close();
  }

  private createClient(options: DingTalkAdapterOptions): DingTalkStreamClient {
    const factory = options.clientFactory ?? createOfficialDingTalkClient;
    return factory({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      autoReconnect: options.autoReconnect ?? DEFAULT_AUTO_RECONNECT,
      keepAlive: options.keepAlive ?? DEFAULT_KEEP_ALIVE,
      ua: options.ua ?? DEFAULT_USER_AGENT,
    });
  }

  private registerRobotCallback(): void {
    if (this.callbackRegistered) {
      return;
    }

    this.client.registerCallbackListener(this.topic, (callback) => {
      this.handleRobotCallback(callback);
    });
    this.callbackRegistered = true;
  }

  private handleRobotCallback(callback: DingTalkRobotCallback): void {
    void this.processRobotCallback(callback).catch((error: unknown) => {
      this.logger.error("DingTalk robot callback handling failed.", {
        error,
        callbackMessageId: callback.headers?.messageId,
        topic: callback.headers?.topic,
      });
    });
  }

  private async connectClient(): Promise<void> {
    if (this.connecting) {
      this.logger.warn("DingTalk Stream connection attempt is already in progress.", {
        topic: this.topic,
      });
      return;
    }

    this.connecting = true;

    try {
      await connectWithoutSdkConsoleLog(this.client, this.logger);
    } finally {
      this.connecting = false;
      if (this.stopping) {
        this.disconnectClient("stopped-during-connect");
      }
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer !== undefined) {
      return;
    }

    if (readClientStatus(this.client).observable === false) {
      this.logger.warn("DingTalk Stream health check disabled; client status is not observable.", {
        topic: this.topic,
      });
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkConnectionHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer === undefined) {
      return;
    }

    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = undefined;
  }

  private checkConnectionHealth(): void {
    if (!this.started || this.stopping) {
      return;
    }

    const status = readClientStatus(this.client);

    if (status.observable === false) {
      return;
    }

    if (status.connected === true) {
      this.reconnectAttempt = 0;
      return;
    }

    if (status.connected !== false) {
      return;
    }

    if (this.connecting || this.reconnectTimer !== undefined) {
      return;
    }

    this.logger.warn("DingTalk Stream connection is unhealthy; scheduling reconnect.", {
      ...createConnectionLogContext(this.client, this.topic),
      reconnectDelayMs: this.getReconnectDelayMs(),
      reconnectStrategy: "adapter-health-check",
    });
    this.scheduleReconnect("health-check");
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.stopping || this.reconnectTimer !== undefined) {
      return;
    }

    const delayMs = this.getReconnectDelayMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect(reason);
    }, delayMs);
  }

  private async reconnect(reason: string): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    this.reconnectAttempt += 1;
    this.logger.warn("Reconnecting DingTalk Stream adapter.", {
      ...createConnectionLogContext(this.client, this.topic),
      reason,
      reconnectAttempt: this.reconnectAttempt,
    });

    try {
      this.disconnectClient("reconnect");
      await this.connectClient();
      this.logger.info(
        "DingTalk Stream adapter reconnect attempt initiated.",
        createConnectionLogContext(this.client, this.topic),
      );
    } catch (error: unknown) {
      const nextReconnectDelayMs = this.getReconnectDelayMs();
      this.logger.error("DingTalk Stream reconnect attempt failed; will retry.", {
        ...createConnectFailureLogContext(error, this.client, this.topic),
        reason,
        reconnectAttempt: this.reconnectAttempt,
        nextReconnectDelayMs,
      });
      this.scheduleReconnect("retry");
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private disconnectClient(reason: string): void {
    try {
      this.client.disconnect();
    } catch (error: unknown) {
      this.logger.error("DingTalk Stream disconnect failed.", {
        error,
        reason,
        topic: this.topic,
      });
    }
  }

  private getReconnectDelayMs(): number {
    return Math.min(
      RECONNECT_INITIAL_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
  }

  private async processRobotCallback(callback: DingTalkRobotCallback): Promise<void> {
    this.logger.debug("Received DingTalk robot callback sample.", {
      sample: createDingTalkCallbackLogSample(callback),
    });

    const mapped = mapDingTalkRobotMessage(callback);

    if (!mapped.ok) {
      this.logMappingWarnings(mapped.warnings);
      this.logger.warn("Ignored unmappable DingTalk robot callback.", {
        reason: mapped.reason,
        callbackMessageId: mapped.callbackMessageId,
      });
      return;
    }

    this.logMappingWarnings(mapped.warnings);
    const dedupeDecision = this.deduper.checkAndRemember(mapped.message);

    if (!dedupeDecision.shouldProcess) {
      this.logDuplicateMessage(dedupeDecision, mapped.message.senderId);
      return;
    }

    this.logger.debug("Mapped DingTalk robot message.", {
      messageId: mapped.message.id,
      senderId: mapped.message.senderId,
      conversationType: mapped.message.conversationType,
      textLength: mapped.message.text.length,
      attachmentCount: mapped.message.attachments?.length ?? 0,
      hasReplyContext: mapped.message.replyContext !== undefined,
    });

    await this.handler(mapped.message, this.createReplySink(mapped.replyContext));
  }

  private logMappingWarnings(warnings: readonly DingTalkMessageMappingWarning[]): void {
    for (const warning of warnings) {
      this.logger.warn("DingTalk robot callback mapping warning.", { warning });
    }
  }

  private logDuplicateMessage(decision: MessageDeduperDecision, senderId: string): void {
    this.logger.warn("Ignored duplicate DingTalk robot message.", {
      messageId: decision.messageId,
      keyType: decision.keyType,
      dedupeKey: decision.key,
      senderId,
      expiresAt: decision.expiresAt.toISOString(),
    });
  }
}

/** Creates the official DingTalk Stream SDK client. */
export function createOfficialDingTalkClient(
  options: DingTalkStreamClientOptions,
): DingTalkStreamClient {
  return new DWClient(options);
}

function patchSdkConsoleLeaks(client: DingTalkStreamClient, logger: Logger): void {
  const sdkClient = client as DebuggableDingTalkStreamClient;
  sdkClient.debug = false;

  if (typeof sdkClient.onDownStream !== "function") {
    return;
  }

  const originalOnDownStream = sdkClient.onDownStream.bind(sdkClient);
  sdkClient.onDownStream = (data: string): void => {
    try {
      runWithoutSdkConsoleLog(logger, () => originalOnDownStream(data));
    } catch (error: unknown) {
      logger.error("DingTalk SDK downstream handling failed; frame ignored.", {
        error,
        dataLength: data.length,
      });
    }
  };
}

function readClientStatus(client: DingTalkStreamClient): {
  connected?: boolean;
  observable: boolean;
  registered?: boolean;
} {
  const sdkClient = client as DebuggableDingTalkStreamClient;
  return {
    connected: sdkClient.connected,
    observable: sdkClient.connected !== undefined || sdkClient.registered !== undefined,
    registered: sdkClient.registered,
  };
}

async function connectWithoutSdkConsoleLog(
  client: DingTalkStreamClient,
  logger: Logger,
): Promise<void> {
  const originalConsoleLog = console.log;
  console.log = createSuppressedConsoleLog(logger);

  try {
    await client.connect();
  } finally {
    console.log = originalConsoleLog;
  }
}

function runWithoutSdkConsoleLog<T>(logger: Logger, action: () => T): T {
  const originalConsoleLog = console.log;
  console.log = createSuppressedConsoleLog(logger);

  try {
    return action();
  } finally {
    console.log = originalConsoleLog;
  }
}

function createSuppressedConsoleLog(logger: Logger): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    logger.debug("Suppressed DingTalk SDK console.log output.", {
      argumentCount: args.length,
    });
  };
}
