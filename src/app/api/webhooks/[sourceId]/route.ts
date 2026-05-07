/**
 * Webhook API Endpoint
 * POST /api/webhooks/{sourceId} - Receive webhook events
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { createWebhookHandler } from "@/lib/polling/handlers/webhook-handler";
import { createDatabaseSourceHandler } from "@/lib/polling/handlers/database-source-handler";
import { findMatchingRules } from "@/lib/task-creation/rule-matcher";
import { createTaskFromSourceEntity } from "@/lib/task-creation/create-task-service";

/**
 * POST /api/webhooks/{sourceId}
 * Receive webhook event and create task immediately
 *
 * Headers:
 * - X-Webhook-Signature: HMAC-SHA256 signature (optional if secret configured)
 *
 * Body: JSON object representing the entity
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;
  const startTime = Date.now();

  try {
    // Get data source configuration
    const dataSource = await prisma.dataSource.findUnique({
      where: { sourceId },
    });

    if (!dataSource) {
      return NextResponse.json(
        { error: "Source not found", code: "SOURCE_NOT_FOUND" },
        { status: 404 }
      );
    }

    // Check if source is active
    if (!dataSource.isActive) {
      return NextResponse.json(
        { error: "Source is inactive", code: "SOURCE_INACTIVE" },
        { status: 403 }
      );
    }

    // Get request body
    const body = await req.text();
    const signature = req.headers.get("x-webhook-signature");

    console.log(
      `[WebhookAPI] Received event for source: ${sourceId} (${body.length} bytes)`
    );

    // Create webhook handler and validate signature
    const webhookHandler = await createWebhookHandler(dataSource.id);

    if (signature) {
      const isValid = webhookHandler.validateWebhookSignature(body, signature);
      if (!isValid) {
        console.warn(`[WebhookAPI] Invalid webhook signature for ${sourceId}`);
        return NextResponse.json(
          { error: "Invalid signature", code: "INVALID_SIGNATURE" },
          { status: 401 }
        );
      }
    }

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      return NextResponse.json(
        { error: "Invalid JSON", code: "INVALID_JSON" },
        { status: 400 }
      );
    }

    // Transform to SourceEntity
    const entity = webhookHandler.processWebhookEvent(payload);

    console.log(
      `[WebhookAPI] Processing entity ${entity.id} type=${entity.type} status=${entity.status}`
    );

    // Find matching rules for this entity
    const rules = await findMatchingRules(sourceId, entity);

    if (rules.length === 0) {
      console.log(
        `[WebhookAPI] No rules match entity ${entity.id} from source ${sourceId}`
      );
      return NextResponse.json({
        success: true,
        tasksCreated: 0,
        message: "Event received but no rules matched",
        processingTimeMs: Date.now() - startTime,
      });
    }

    // Create tasks for each matching rule
    const taskCreationResults = [];
    for (const rule of rules) {
      try {
        const result = await createTaskFromSourceEntity(
          sourceId,
          entity,
          rule,
          dataSource.displayName,
          (payload.storeId as number) || undefined
        );

        taskCreationResults.push({
          rule: rule.ruleName,
          taskId: result.taskId,
          success: result.success,
          error: result.error,
        });

        if (result.success) {
          console.log(
            `[WebhookAPI] Created task #${result.taskId} from rule "${rule.ruleName}"`
          );
        }
      } catch (error) {
        console.error(`[WebhookAPI] Failed to create task from rule ${rule.ruleName}:`, error);
        taskCreationResults.push({
          rule: rule.ruleName,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Log webhook event
    await prisma.dataSourcePollingLog.create({
      data: {
        dataSourceId: dataSource.id,
        pollStartedAt: new Date(startTime),
        pollCompletedAt: new Date(),
        durationMs: Date.now() - startTime,
        entitiesFound: 1,
        entitiesProcessed: 1,
        tasksCreated: taskCreationResults.filter((r) => r.success).length,
        tasksFailed: taskCreationResults.filter((r) => !r.success).length,
        status:
          taskCreationResults.some((r) => r.success) &&
          taskCreationResults.some((r) => !r.success)
            ? "PARTIAL"
            : taskCreationResults.every((r) => r.success)
              ? "SUCCESS"
              : "ERROR",
        details: {
          event: "webhook",
          entityId: entity.id,
          entityType: entity.type,
          matchedRules: rules.length,
          taskCreationResults,
        } as any,
      },
    });

    const successCount = taskCreationResults.filter((r) => r.success).length;

    return NextResponse.json({
      success: true,
      entityId: entity.id,
      entityType: entity.type,
      matchedRules: rules.length,
      tasksCreated: successCount,
      tasksFailed: taskCreationResults.filter((r) => !r.success).length,
      taskResults: taskCreationResults,
      processingTimeMs: Date.now() - startTime,
    });
  } catch (error) {
    console.error(`[WebhookAPI] Error processing webhook for ${sourceId}:`, error);

    return NextResponse.json(
      {
        error: "Webhook processing failed",
        code: "WEBHOOK_ERROR",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}

/**
 * Webhook health check
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  const { sourceId } = await params;

  try {
    const dataSource = await prisma.dataSource.findUnique({
      where: { sourceId },
    });

    if (!dataSource) {
      return NextResponse.json(
        { error: "Source not found", code: "SOURCE_NOT_FOUND" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      webhook: {
        sourceId: dataSource.sourceId,
        displayName: dataSource.displayName,
        isActive: dataSource.isActive,
        url: `/api/webhooks/${sourceId}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": "HMAC-SHA256 (optional)",
        },
      },
      status: "active",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get webhook status", code: "WEBHOOK_STATUS_ERROR" },
      { status: 500 }
    );
  }
}
