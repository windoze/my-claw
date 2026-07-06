/** Bounded in-memory deduplication for DingTalk Stream message deliveries. */

import { createHash } from "node:crypto";

import type { IncomingMessage } from "../messages/types.js";
import { createLogger, type Logger } from "../utils/logger.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1_000;

/** Key source used to decide whether an inbound message was already seen. */
export type MessageDeduperKeyType = "message-id" | "weak";

/** Options accepted by the in-memory message deduper. */
export interface MessageDeduperOptions {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => Date;
  logger?: Logger;
}

/** Decision returned after checking and optionally recording a message. */
export interface MessageDeduperDecision {
  shouldProcess: boolean;
  duplicate: boolean;
  key: string;
  keyType: MessageDeduperKeyType;
  messageId?: string;
  expiresAt: Date;
  existingExpiresAt?: Date;
}

interface DedupeKey {
  key: string;
  keyType: MessageDeduperKeyType;
  messageId?: string;
  windowStart?: Date;
  hash?: string;
}

/** Tracks recent DingTalk message deliveries and rejects duplicates within the TTL window. */
export class MessageDeduper {
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly seen = new Map<string, number>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  public constructor(options: MessageDeduperOptions = {}) {
    this.ttlMs = normalizePositiveMilliseconds(options.ttlMs, "ttlMs", DEFAULT_TTL_MS);
    this.cleanupIntervalMs = normalizeNonNegativeMilliseconds(
      options.cleanupIntervalMs,
      "cleanupIntervalMs",
      DEFAULT_CLEANUP_INTERVAL_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? createLogger("dingtalk:dedupe");
    this.startCleanupTimer();
  }

  /** Returns true only for the first delivery of a message within the TTL. */
  public checkAndRemember(message: IncomingMessage): MessageDeduperDecision {
    const nowMs = this.currentTimeMs();
    this.cleanupExpired(nowMs);

    const dedupeKey = this.createDedupeKey(message, nowMs);
    this.logWeakKeyIfNeeded(message, dedupeKey);

    const existingExpiresAtMs = this.seen.get(dedupeKey.key);
    if (existingExpiresAtMs !== undefined && existingExpiresAtMs > nowMs) {
      return {
        shouldProcess: false,
        duplicate: true,
        key: dedupeKey.key,
        keyType: dedupeKey.keyType,
        ...(dedupeKey.messageId !== undefined ? { messageId: dedupeKey.messageId } : {}),
        expiresAt: new Date(existingExpiresAtMs),
        existingExpiresAt: new Date(existingExpiresAtMs),
      };
    }

    const expiresAtMs = nowMs + this.ttlMs;
    this.seen.set(dedupeKey.key, expiresAtMs);

    return {
      shouldProcess: true,
      duplicate: false,
      key: dedupeKey.key,
      keyType: dedupeKey.keyType,
      ...(dedupeKey.messageId !== undefined ? { messageId: dedupeKey.messageId } : {}),
      expiresAt: new Date(expiresAtMs),
    };
  }

  /** Removes expired entries immediately and returns how many keys were pruned. */
  public cleanup(): number {
    return this.cleanupExpired(this.currentTimeMs());
  }

  /** Stops the background cleanup timer for application shutdown or focused checks. */
  public close(): void {
    if (this.cleanupTimer === undefined) {
      return;
    }

    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  /** Exposes the current map size for focused validation without leaking entries. */
  public get size(): number {
    return this.seen.size;
  }

  private startCleanupTimer(): void {
    if (this.cleanupIntervalMs === 0) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  private cleanupExpired(nowMs: number): number {
    let removed = 0;

    for (const [key, expiresAtMs] of this.seen.entries()) {
      if (expiresAtMs <= nowMs) {
        this.seen.delete(key);
        removed += 1;
      }
    }

    if (removed > 0) {
      this.logger.debug("Pruned expired DingTalk message dedupe entries.", {
        removed,
        remaining: this.seen.size,
      });
    }

    return removed;
  }

  private createDedupeKey(message: IncomingMessage, nowMs: number): DedupeKey {
    const messageId = normalizeMessageId(message.id);

    if (messageId !== undefined) {
      return {
        key: `message-id:${messageId}`,
        keyType: "message-id",
        messageId,
      };
    }

    const windowStartMs = Math.floor(nowMs / this.ttlMs) * this.ttlMs;
    const hash = hashWeakMessageIdentity(message);

    return {
      key: `weak:${message.senderId}:${message.conversationType}:${windowStartMs}:${hash}`,
      keyType: "weak",
      windowStart: new Date(windowStartMs),
      hash,
    };
  }

  private logWeakKeyIfNeeded(message: IncomingMessage, dedupeKey: DedupeKey): void {
    if (dedupeKey.keyType !== "weak") {
      return;
    }

    this.logger.warn("DingTalk message id is missing; using weak dedupe key.", {
      senderId: message.senderId,
      conversationType: message.conversationType,
      textLength: message.text.length,
      attachmentCount: message.attachments?.length ?? 0,
      weakHash: dedupeKey.hash,
      windowStart: dedupeKey.windowStart?.toISOString(),
      ttlMs: this.ttlMs,
    });
  }

  private currentTimeMs(): number {
    return this.now().getTime();
  }
}

function hashWeakMessageIdentity(message: IncomingMessage): string {
  return createHash("sha256")
    .update(message.senderId)
    .update("\0")
    .update(message.conversationType)
    .update("\0")
    .update(message.text)
    .update("\0")
    .update(JSON.stringify(summarizeAttachments(message)))
    .digest("hex")
    .slice(0, 16);
}

function summarizeAttachments(message: IncomingMessage): unknown[] {
  return (message.attachments ?? []).map((attachment) => ({
    type: attachment.type,
    filename: attachment.filename,
    mime: attachment.mime,
    downloadCode: attachment.downloadCode,
    localPath: attachment.localPath,
    size: attachment.size,
  }));
}

function normalizeMessageId(messageId: string | undefined): string | undefined {
  const trimmedMessageId = messageId?.trim();
  return trimmedMessageId === undefined || trimmedMessageId.length === 0
    ? undefined
    : trimmedMessageId;
}

function normalizePositiveMilliseconds(
  value: number | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`MessageDeduper ${optionName} must be a positive finite number.`);
  }

  return value;
}

function normalizeNonNegativeMilliseconds(
  value: number | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`MessageDeduper ${optionName} must be a non-negative finite number.`);
  }

  return value;
}
