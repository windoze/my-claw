/** Safe connection-state logging around DingTalk Stream SDK lifecycle hooks. */

import type { Logger } from "../utils/logger.js";
import type { DingTalkRobotCallback, DingTalkStreamClient } from "./types.js";

/** Cleanup hook returned after lifecycle observers are installed. */
export type StreamLifecycleCleanup = () => void;

interface DebuggableDingTalkStreamClient extends DingTalkStreamClient {
  connected?: boolean;
  registered?: boolean;
  reconnecting?: boolean;
  printDebug?: (message: unknown) => void;
  onSystem?: (downstream: DingTalkRobotCallback) => void;
}

/** Installs SDK lifecycle observers and returns an idempotent cleanup callback. */
export function installStreamLifecycleLogging(
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): StreamLifecycleCleanup {
  const cleanups: StreamLifecycleCleanup[] = [
    attachClientEventLogging(client, logger, topic),
    patchSdkDebugLifecycleLogging(client, logger, topic),
    patchSdkSystemLifecycleLogging(client, logger, topic),
  ];
  let cleanedUp = false;

  return (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
  };
}

/** Builds non-secret connection metadata for routine Stream lifecycle logs. */
export function createConnectionLogContext(
  client: DingTalkStreamClient,
  topic: string,
): Record<string, unknown> {
  const config = client.getConfig?.();
  const statusClient = client as DebuggableDingTalkStreamClient;

  return {
    topic,
    keepAlive: config?.keepAlive,
    autoReconnect: config?.autoReconnect ?? true,
    connected: statusClient.connected,
    registered: statusClient.registered,
    reconnecting: statusClient.reconnecting,
  };
}

/** Adds a classified reason and suggested action to failed Stream connection logs. */
export function createConnectFailureLogContext(
  error: unknown,
  client: DingTalkStreamClient,
  topic: string,
): Record<string, unknown> {
  const classification = classifyConnectFailure(error);

  return {
    ...createConnectionLogContext(client, topic),
    reason: classification.reason,
    action: classification.action,
    errorCode: readErrorCode(error),
    httpStatus: readHttpStatus(error),
    error,
  };
}

function attachClientEventLogging(
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): StreamLifecycleCleanup {
  if (typeof client.on !== "function") {
    logger.info("DingTalk Stream SDK auto-reconnect is enabled; public close events unavailable.", {
      ...createConnectionLogContext(client, topic),
      reconnectStrategy: "sdk-auto-reconnect",
    });
    return noop;
  }

  const onOpen = (): void => {
    logger.info("DingTalk Stream client emitted open.", createConnectionLogContext(client, topic));
  };
  const onClose = (...args: unknown[]): void => {
    logger.warn("DingTalk Stream client emitted close; reconnect will be handled by SDK.", {
      ...createConnectionLogContext(client, topic),
      closeArgsCount: args.length,
      reconnectStrategy: "sdk-auto-reconnect",
    });
  };
  const onError = (error: unknown): void => {
    logger.error("DingTalk Stream client emitted error.", {
      ...createConnectionLogContext(client, topic),
      error,
    });
  };

  client.on("open", onOpen);
  client.on("close", onClose);
  client.on("error", onError);

  return (): void => {
    removeClientListener(client, "open", onOpen);
    removeClientListener(client, "close", onClose);
    removeClientListener(client, "error", onError);
  };
}

function patchSdkDebugLifecycleLogging(
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): StreamLifecycleCleanup {
  const sdkClient = client as DebuggableDingTalkStreamClient;

  if (typeof sdkClient.printDebug !== "function") {
    return noop;
  }

  const originalPrintDebug = sdkClient.printDebug.bind(sdkClient);
  sdkClient.printDebug = (message: unknown): void => {
    logSdkDebugLifecycleMessage(message, client, logger, topic);
    originalPrintDebug(message);
  };

  return (): void => {
    sdkClient.printDebug = originalPrintDebug;
  };
}

function patchSdkSystemLifecycleLogging(
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): StreamLifecycleCleanup {
  const sdkClient = client as DebuggableDingTalkStreamClient;

  if (typeof sdkClient.onSystem !== "function") {
    return noop;
  }

  const originalOnSystem = sdkClient.onSystem.bind(sdkClient);
  sdkClient.onSystem = (downstream: DingTalkRobotCallback): void => {
    logSdkSystemLifecycleMessage(downstream, client, logger, topic);
    originalOnSystem(downstream);
  };

  return (): void => {
    sdkClient.onSystem = originalOnSystem;
  };
}

function logSdkDebugLifecycleMessage(
  message: unknown,
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): void {
  // The SDK calls printDebug with non-string payloads (e.g. downstream message
  // objects) on every inbound message; only string debug lines carry the
  // lifecycle text we classify below, so skip anything else.
  if (typeof message !== "string") {
    return;
  }

  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("socket open")) {
    logger.info("DingTalk Stream socket opened.", createConnectionLogContext(client, topic));
    return;
  }

  if (normalizedMessage.includes("socket closed")) {
    logger.warn("DingTalk Stream socket closed; SDK auto-reconnect will retry if enabled.", {
      ...createConnectionLogContext(client, topic),
      reconnectStrategy: "sdk-auto-reconnect",
    });
    return;
  }

  const reconnectDelayMs = parseReconnectDelayMs(message);
  if (reconnectDelayMs !== undefined) {
    logger.warn("DingTalk Stream SDK scheduled reconnect.", {
      ...createConnectionLogContext(client, topic),
      reconnectDelayMs,
      reconnectStrategy: "sdk-auto-reconnect",
    });
    return;
  }

  if (normalizedMessage.includes("get connect endpoint")) {
    logger.debug("DingTalk Stream SDK is requesting connection endpoint.", {
      topic,
    });
  }
}

function logSdkSystemLifecycleMessage(
  downstream: DingTalkRobotCallback,
  client: DingTalkStreamClient,
  logger: Logger,
  topic: string,
): void {
  switch (downstream.headers.topic) {
    case "CONNECTED":
      logger.info("DingTalk Stream server acknowledged connection.", {
        ...createConnectionLogContext(client, topic),
        connectionId: downstream.headers.connectionId,
      });
      break;
    case "REGISTERED":
      logger.info("DingTalk Stream callback subscription registered.", {
        ...createConnectionLogContext(client, topic),
        connectionId: downstream.headers.connectionId,
      });
      break;
    case "disconnect":
      logger.warn("DingTalk Stream server requested disconnect; SDK should reconnect if enabled.", {
        ...createConnectionLogContext(client, topic),
        connectionId: downstream.headers.connectionId,
        reconnectStrategy: "sdk-auto-reconnect",
      });
      break;
    case "KEEPALIVE":
    case "ping":
      logger.debug("DingTalk Stream keepalive received.", {
        topic,
        systemTopic: downstream.headers.topic,
      });
      break;
  }
}

function removeClientListener(
  client: DingTalkStreamClient,
  eventName: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof client.off === "function") {
    client.off(eventName, listener);
    return;
  }

  client.removeListener?.(eventName, listener);
}

function classifyConnectFailure(error: unknown): { reason: string; action: string } {
  const message = formatUnknownErrorMessage(error).toLowerCase();
  const errorCode = readErrorCode(error);
  const httpStatus = readHttpStatus(error);

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    message.includes("clientid") ||
    message.includes("clientsecret") ||
    message.includes("access_token") ||
    message.includes("credential")
  ) {
    return {
      reason: "credential",
      action: "Verify dingtalk.clientId/clientSecret and that the DingTalk app is published.",
    };
  }

  if (
    isNetworkErrorCode(errorCode) ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("enotfound")
  ) {
    return {
      reason: "network",
      action: "Check outbound network access to DingTalk Open Platform and retry.",
    };
  }

  if (message.includes("endpoint") || message.includes("ticket")) {
    return {
      reason: "stream-endpoint",
      action: "Verify Stream Mode is enabled for the robot and retry connection.",
    };
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return {
      reason: "dingtalk-service",
      action: "Check DingTalk Open Platform status and retry later.",
    };
  }

  return {
    reason: "unknown",
    action: "Check DingTalk credentials, Stream Mode settings, and network connectivity.",
  };
}

function isNetworkErrorCode(errorCode: string | undefined): boolean {
  return (
    errorCode === "ECONNRESET" ||
    errorCode === "ECONNREFUSED" ||
    errorCode === "ETIMEDOUT" ||
    errorCode === "ENOTFOUND" ||
    errorCode === "EAI_AGAIN"
  );
}

function parseReconnectDelayMs(message: string): number | undefined {
  const match = /reconnecting in\s+(\d+(?:\.\d+)?)\s+seconds?/i.exec(message);
  if (match === null) {
    return undefined;
  }

  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function readHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  if (typeof error.status === "number") {
    return error.status;
  }

  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }

  return undefined;
}

function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noop(): void {
  return undefined;
}
