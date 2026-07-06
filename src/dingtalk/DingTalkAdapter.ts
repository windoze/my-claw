/** DingTalk Stream Mode adapter that maps robot callbacks into internal messages. */

import { DWClient, TOPIC_ROBOT } from "dingtalk-stream-sdk-nodejs";

import { AppError, createLogger, type Logger } from "../utils/index.js";
import { DingTalkReplySink } from "./DingTalkReplySink.js";
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
const DEFAULT_USER_AGENT = "my-claw-dingtalk-agent";

interface DebuggableDingTalkStreamClient extends DingTalkStreamClient {
  debug?: boolean;
  onDownStream?: (data: string) => void;
}

/** Connects to DingTalk Stream Mode and forwards robot messages to the injected handler. */
export class DingTalkAdapter {
  private readonly config: DingTalkAdapterOptions["config"];
  private readonly handler: DingTalkAdapterOptions["handler"];
  private readonly createReplySink: DingTalkReplySinkFactory;
  private readonly client: DingTalkStreamClient;
  private readonly deduper: MessageDeduper;
  private readonly logger: Logger;
  private readonly topic: string;
  private readonly lifecycleCleanup: StreamLifecycleCleanup;
  private callbackRegistered = false;
  private started = false;

  public constructor(options: DingTalkAdapterOptions) {
    this.config = options.config;
    this.handler = options.handler;
    this.logger = options.logger ?? createLogger("dingtalk");
    this.createReplySink =
      options.createReplySink ??
      ((context) =>
        new DingTalkReplySink({
          context,
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

    this.registerRobotCallback();

    try {
      this.logger.info(
        "Connecting DingTalk Stream adapter.",
        createConnectionLogContext(this.client, this.topic),
      );
      await connectWithoutSdkConsoleLog(this.client, this.logger);
      this.started = true;
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

    this.client.disconnect();
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
        callbackMessageId: callback.headers.messageId,
        topic: callback.headers.topic,
      });
    });
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
    runWithoutSdkConsoleLog(logger, () => originalOnDownStream(data));
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
