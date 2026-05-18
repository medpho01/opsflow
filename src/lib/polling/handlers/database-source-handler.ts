/**
 * Database Source Handler
 * Generic, configurable handler for any database table
 * Scales to unlimited sources without code changes - only database configuration
 */

import prisma from "@/lib/db/client";
import labstack from "@/lib/db/labstack";
import {
  ISourceHandler,
  SourceEntity,
  SourceInfo,
  SourceMetadata,
  ValidationResult,
} from "@/types/multi-source";

export interface DatabaseSourceConfig {
  sourceId: string;
  displayName: string;
  tableReference: string; // e.g., "public.orders", "public.appointments"
  primaryKeyField: string; // e.g., "id"
  typeFieldName: string; // e.g., "orderType", "appointmentType"
  statusFieldName: string; // e.g., "orderStatus", "appointmentStatus"
  queryTemplate: string; // SQL with $since placeholder
  metadataFieldMapping?: Record<string, string>; // Maps output names to DB column names
}

/** Double-quote a PostgreSQL identifier (table or column name) */
function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export class DatabaseSourceHandler implements ISourceHandler {
  private config: DatabaseSourceConfig;

  constructor(config: DatabaseSourceConfig) {
    this.config = config;
  }

  /**
   * Get metadata about this source
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
   * Fetch entities from the configured table
   * Uses the configured query template and field mappings
   */
  async fetchEntitiesNeedingTasks(since: Date, limit: number): Promise<SourceEntity[]> {
    try {
      // Build the query - replace placeholders
      const query = this.config.queryTemplate
        .replace("$1", `'${since.toISOString()}'`)
        .replace("$2", String(limit));

      console.log(
        `[DatabaseSourceHandler] Executing query for ${this.config.sourceId}: ${query.substring(0, 100)}...`
      );

      // Execute the query
      const rows = await labstack.$queryRawUnsafe(query) as any[];

      if (!rows || rows.length === 0) {
        return [];
      }

      // Transform rows to SourceEntity format using field mappings
      return rows.map((row) => {
        const typeFieldValue = row[this.config.typeFieldName];
        const statusFieldValue = row[this.config.statusFieldName];

        // Build metadata object using field mappings
        const metadata: Record<string, unknown> = {};
        if (this.config.metadataFieldMapping) {
          for (const [outputName, dbColumnName] of Object.entries(
            this.config.metadataFieldMapping
          )) {
            metadata[outputName] = row[dbColumnName];
          }
        }

        // Always include the type and status in metadata
        metadata[this.config.typeFieldName] = typeFieldValue;
        metadata[this.config.statusFieldName] = statusFieldValue;

        // Include all row data in metadata for flexibility
        metadata._rawRow = row;

        return {
          id: row[this.config.primaryKeyField],
          type: typeFieldValue || "UNKNOWN",
          status: statusFieldValue || "UNKNOWN",
          metadata,
          createdAt: row.created_at ? new Date(row.created_at) : new Date(),
          modifiedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
        };
      });
    } catch (error) {
      console.error(
        `[DatabaseSourceHandler] Error fetching from ${this.config.sourceId}:`,
        error
      );

      // Check if it's a table-not-found error
      if (
        error instanceof Error &&
        (error.message.includes("does not exist") ||
          error.message.includes("relation") ||
          error.message.includes("table"))
      ) {
        console.warn(
          `[DatabaseSourceHandler] Table not found for ${this.config.sourceId}, returning empty results`
        );
        return [];
      }

      throw error;
    }
  }

  /**
   * Sync task status back to the source table.
   *
   * Intentional no-op. Source databases (notably labstack's `public` schema)
   * are READ-ONLY from OpsFlow. The previous implementation issued
   * `UPDATE <table> SET updated_at = NOW()` on task completion, which
   * mutated the source row. That has been removed; OpsFlow records all
   * task lifecycle facts on its own side (taskos.task_history,
   * taskos.tasks). If a future feature genuinely needs to push state
   * back, do it through a sanctioned external API — never raw SQL into
   * the source schema.
   */
  async syncTaskStatusToSource(
    _taskId: number,
    _sourceEntityId: number | string,
    _newStatus: string,
    _context: Record<string, unknown>
  ): Promise<void> {
    // no-op by design — see docblock
    return;
  }

  /**
   * Validate connection to the configured table
   */
  async validateConnection(): Promise<ValidationResult> {
    try {
      // Try to count rows in the table
      const countQuery = `SELECT COUNT(*) as count FROM ${this.config.tableReference}`;
      const result = await labstack.$queryRawUnsafe<[{ count: number }]>(countQuery);

      return {
        ok: true,
        message: `Successfully connected to ${this.config.displayName} table`,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("does not exist") ||
          error.message.includes("relation") ||
          error.message.includes("table"))
      ) {
        return {
          ok: false,
          message: `Table not found: ${this.config.tableReference}. Please create the table or verify the configuration.`,
        };
      }

      return {
        ok: false,
        message: `Failed to connect to ${this.config.displayName}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      };
    }
  }

  /**
   * Get available types and statuses from the configured table
   */
  async getAvailableMetadata(): Promise<SourceMetadata> {
    try {
      // Fetch distinct type and status values
      const typesQuery = `
        SELECT DISTINCT ${qi(this.config.typeFieldName)} as type
        FROM ${this.config.tableReference}
        WHERE ${qi(this.config.typeFieldName)} IS NOT NULL
        LIMIT 100
      `;

      const statusesQuery = `
        SELECT DISTINCT ${qi(this.config.statusFieldName)} as status
        FROM ${this.config.tableReference}
        WHERE ${qi(this.config.statusFieldName)} IS NOT NULL
        LIMIT 100
      `;

      const types = await labstack.$queryRawUnsafe<Array<{ type: string }>>(typesQuery);
      const statuses = await labstack.$queryRawUnsafe<Array<{ status: string }>>(
        statusesQuery
      );

      const typeSet = new Set(types?.map((t) => t.type).filter(Boolean));
      const statusSet = new Set(statuses?.map((s) => s.status).filter(Boolean));

      // Build metadata fields from configuration
      const metadataFields = Object.entries(
        this.config.metadataFieldMapping || {}
      ).map(([outputName, dbColumn]) => ({
        name: outputName,
        type: "string" as const,
        displayName: outputName.replace(/_/g, " "),
      }));

      return {
        availableTypes: Array.from(typeSet).map((t) => ({
          label: t?.replace(/_/g, " ") || "Unknown",
          value: t || "UNKNOWN",
        })),
        availableStatuses: Array.from(statusSet).map((s) => ({
          label: s?.replace(/_/g, " ") || "Unknown",
          value: s || "UNKNOWN",
        })),
        metadataFields,
      };
    } catch (error) {
      console.error(
        `[DatabaseSourceHandler] Error getting metadata for ${this.config.sourceId}:`,
        error
      );

      // Return empty metadata if table doesn't exist yet
      return {
        availableTypes: [],
        availableStatuses: [],
        metadataFields: Object.entries(this.config.metadataFieldMapping || {}).map(
          ([outputName]) => ({
            name: outputName,
            type: "string" as const,
            displayName: outputName.replace(/_/g, " "),
          })
        ),
      };
    }
  }
}

/**
 * Factory function to create a database source handler from DataSource config
 */
export async function createDatabaseSourceHandler(
  dataSourceId: string
): Promise<DatabaseSourceHandler> {
  const dataSource = await prisma.dataSource.findUnique({
    where: { id: dataSourceId },
  });

  if (!dataSource) {
    throw new Error(`Data source not found: ${dataSourceId}`);
  }

  return new DatabaseSourceHandler({
    sourceId: dataSource.sourceId,
    displayName: dataSource.displayName,
    tableReference: dataSource.tableReference,
    primaryKeyField: dataSource.primaryKeyField,
    typeFieldName: dataSource.typeFieldName,
    statusFieldName: dataSource.statusFieldName,
    queryTemplate: dataSource.queryTemplate,
    metadataFieldMapping: dataSource.metadataFieldMapping as any,
  });
}
