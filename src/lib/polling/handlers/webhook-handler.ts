/**
 * Webhook Source Handler
 * Implements ISourceHandler for real-time webhook events
 * Enables external systems to push events instead of polling
 */

import prisma from "@/lib/db/client";
import {
  ISourceHandler,
  SourceEntity,
  SourceInfo,
  SourceMetadata,
  ValidationResult,
} from "@/types/multi-source";
import crypto from "crypto";

export interface WebhookConfig {
  sourceId: string;
  displayName: string;
  webhookUrl?: string;
  webhookSecret?: string;
  typeFieldName: string;
  statusFieldName: string;
  primaryKeyField: string;
  metadataFieldMapping?: Record<string, string>;
}

export class WebhookSourceHandler implements ISourceHandler {
  private config: WebhookConfig;
  private eventQueue: SourceEntity[] = [];

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  /**
   * Get metadata about this webhook source
   */
  getSourceInfo(): SourceInfo {
    return {
      sourceId: this.config.sourceId,
      displayName: this.config.displayName,
      primaryKeyField: this.config.primaryKeyField,
      typeField: this.config.typeFieldName,
      statusField: this.config.statusFieldName,
    };
  }

  /**
   * Validate webhook signature
   * Supports HMAC-SHA256 with secret
   */
  validateWebhookSignature(
    payload: string,
    signature: string
  ): boolean {
    if (!this.config.webhookSecret) {
      console.warn(
        `[WebhookHandler] No webhook secret configured for ${this.config.sourceId}`
      );
      return true; // Allow if no secret configured
    }

    const expectedSignature = crypto
      .createHmac("sha256", this.config.webhookSecret)
      .update(payload)
      .digest("hex");

    const valid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    return valid;
  }

  /**
   * Process incoming webhook event
   * Transforms webhook payload to SourceEntity
   */
  processWebhookEvent(payload: Record<string, unknown>): SourceEntity {
    const typeFieldValue = payload[this.config.typeFieldName];
    const statusFieldValue = payload[this.config.statusFieldName];

    // Build metadata from payload
    const metadata: Record<string, unknown> = {};
    if (this.config.metadataFieldMapping) {
      for (const [outputName, payloadField] of Object.entries(
        this.config.metadataFieldMapping
      )) {
        metadata[outputName] = payload[payloadField];
      }
    }

    // Always include type and status in metadata
    metadata[this.config.typeFieldName] = typeFieldValue;
    metadata[this.config.statusFieldName] = statusFieldValue;

    // Include raw payload for flexibility
    metadata._rawPayload = payload;

    return {
      id: payload[this.config.primaryKeyField] as string | number,
      type: typeFieldValue ? String(typeFieldValue) : "UNKNOWN",
      status: statusFieldValue ? String(statusFieldValue) : "UNKNOWN",
      metadata,
      createdAt: payload.createdAt ? new Date(payload.createdAt as string) : new Date(),
      modifiedAt: payload.updatedAt ? new Date(payload.updatedAt as string) : new Date(),
    };
  }

  /**
   * Queue event for processing
   */
  queueEvent(event: SourceEntity): void {
    this.eventQueue.push(event);
    console.log(
      `[WebhookHandler] Queued event for ${this.config.sourceId}: ${event.id}`
    );
  }

  /**
   * Get queued events (for polling-like consumption)
   * Note: Webhooks don't use _since timestamp — we drain the queue up to limit.
   */
  async fetchEntitiesNeedingTasks(
    _since?: Date,
    limit?: number
  ): Promise<SourceEntity[]> {
    if (limit !== undefined) {
      const entities = this.eventQueue.slice(0, limit);
      this.eventQueue = this.eventQueue.slice(limit);
      return entities;
    }
    const entities = [...this.eventQueue];
    this.eventQueue = [];
    return entities;
  }

  /**
   * Sync task status back to source via webhook callback
   */
  async syncTaskStatusToSource(
    taskId: number,
    sourceEntityId: number | string,
    newStatus: string,
    context: Record<string, unknown>
  ): Promise<void> {
    try {
      if (!this.config.webhookUrl) {
        console.warn(
          `[WebhookHandler] No webhook URL configured for syncing back to ${this.config.sourceId}`
        );
        return;
      }

      // Prepare sync payload
      const payload = {
        event: "task.status.changed",
        taskId,
        sourceEntityId,
        newStatus,
        timestamp: new Date().toISOString(),
        context,
      };

      const payloadJson = JSON.stringify(payload);

      // Sign payload if secret is configured
      let headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.config.webhookSecret) {
        const signature = crypto
          .createHmac("sha256", this.config.webhookSecret)
          .update(payloadJson)
          .digest("hex");

        headers["X-Webhook-Signature"] = signature;
      }

      // Send sync webhook
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers,
        body: payloadJson,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }

      console.log(
        `[WebhookHandler] Synced task #${taskId} status to ${this.config.sourceId}`
      );
    } catch (error) {
      console.error(
        `[WebhookHandler] Error syncing task #${taskId} to ${this.config.sourceId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Validate webhook configuration
   * For webhooks, just verify the config is valid (no actual connection test)
   */
  async validateConnection(): Promise<ValidationResult> {
    try {
      // Validate required fields
      if (!this.config.sourceId || !this.config.displayName) {
        return {
          ok: false,
          message: "Webhook source missing required configuration",
        };
      }

      // Warn if no webhook URL (may be set up later)
      if (!this.config.webhookUrl) {
        console.warn(
          `[WebhookHandler] No webhook URL configured for ${this.config.sourceId} (will accept events once URL is set)`
        );
      }

      return {
        ok: true,
        message: `Webhook source configured: ${this.config.displayName}${
          this.config.webhookUrl ? ` (${this.config.webhookUrl})` : " (URL pending)"
        }`,
      };
    } catch (error) {
      return {
        ok: false,
        message: `Webhook validation failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  /**
   * Get available webhook event types and statuses
   * Can be static or fetched from configuration
   */
  async getAvailableMetadata(): Promise<SourceMetadata> {
    // For webhooks, metadata is typically discovered from received events
    // This is a template that can be updated as events are received

    return {
      availableTypes: [
        { label: "Event", value: "EVENT" },
        { label: "Unknown", value: "UNKNOWN" },
      ],
      availableStatuses: [
        { label: "Created", value: "CREATED" },
        { label: "Updated", value: "UPDATED" },
        { label: "Unknown", value: "UNKNOWN" },
      ],
      metadataFields: Object.entries(
        this.config.metadataFieldMapping || {}
      ).map(([outputName]) => ({
        name: outputName,
        type: "string" as const,
        displayName: outputName.replace(/_/g, " "),
      })),
    };
  }
}

/**
 * Factory function to create webhook handler from DataSource config
 */
export async function createWebhookHandler(
  dataSourceId: string
): Promise<WebhookSourceHandler> {
  const dataSource = await prisma.dataSource.findUnique({
    where: { id: dataSourceId },
  });

  if (!dataSource) {
    throw new Error(`Data source not found: ${dataSourceId}`);
  }

  const config = dataSource.syncEndpoint; // Reuse syncEndpoint for webhook URL
  const credentials = dataSource.syncCredentials as any;

  return new WebhookSourceHandler({
    sourceId: dataSource.sourceId,
    displayName: dataSource.displayName,
    webhookUrl: config ?? undefined, // Where to send sync-back
    webhookSecret: credentials?.secret, // Shared secret for validation
    typeFieldName: dataSource.typeFieldName,
    statusFieldName: dataSource.statusFieldName,
    primaryKeyField: dataSource.primaryKeyField,
    metadataFieldMapping: dataSource.metadataFieldMapping as any,
  });
}
