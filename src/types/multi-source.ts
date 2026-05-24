/**
 * Multi-Source Task System - TypeScript Type Definitions
 * Defines interfaces and types for supporting task creation from multiple data sources
 */

// ─────────────────────────────────────────────
// SOURCE HANDLER INTERFACE
// ─────────────────────────────────────────────

/**
 * Represents a single entity from a data source that may need a task
 */
export interface SourceEntity {
  id: number | string;              // Primary key from source
  type: string;                      // Type field value (e.g., "BLOOD_TEST")
  status: string;                    // Status field value (e.g., "CREATED")
  metadata: Record<string, unknown>; // Source-specific metadata
  createdAt: Date;
  modifiedAt: Date;
}

/**
 * Metadata about a data source
 */
export interface SourceInfo {
  sourceId: string;           // Unique identifier (e.g., "orders")
  displayName: string;        // User-friendly name (e.g., "Lab Orders")
  primaryKeyField: string;    // Name of primary key field
  typeField: string;          // Name of type field
  statusField: string;        // Name of status field
}

/**
 * Available types and statuses for a source
 */
export interface SourceMetadata {
  availableTypes: Array<{
    label: string;
    value: string;
  }>;
  availableStatuses: Array<{
    label: string;
    value: string;
  }>;
  metadataFields: Array<{
    name: string;
    type: "string" | "number" | "datetime" | "boolean";
    displayName?: string;
  }>;
}

/**
 * Validation result when checking source connectivity
 */
export interface ValidationResult {
  ok: boolean;
  message: string;
}

/**
 * Interface that all data source handlers must implement
 * Enables plugin-based architecture for supporting multiple data sources
 */
export interface ISourceHandler {
  /**
   * Get metadata about this source
   */
  getSourceInfo(): SourceInfo;

  /**
   * Fetch entities from source that may need task review
   * @param since Only fetch entities created/modified since this time
   * @param limit Maximum number of entities to fetch per batch
   * @returns Array of entities from source
   */
  fetchEntitiesNeedingTasks(since: Date, limit: number): Promise<SourceEntity[]>;

  /**
   * Sync task status back to source system
   * Called when a task's status changes
   * @param taskId ID of the task in TaskOS
   * @param sourceEntityId ID of entity in source system
   * @param newStatus New task status
   * @param context Task metadata/context for reference
   */
  syncTaskStatusToSource(
    taskId: number,
    sourceEntityId: number | string,
    newStatus: string,
    context: Record<string, unknown>
  ): Promise<void>;

  /**
   * Validate that source is accessible and configured correctly
   * Called during source registration
   */
  validateConnection(): Promise<ValidationResult>;

  /**
   * Get available types and statuses for this source
   * Called during configuration
   */
  getAvailableMetadata(): Promise<SourceMetadata>;
}

// ─────────────────────────────────────────────
// POLLING ENGINE TYPES
// ─────────────────────────────────────────────

/**
 * Polling cycle result for a single source
 */
export interface PollingCycleResult {
  sourceId: string;
  status: "SUCCESS" | "ERROR" | "PARTIAL";
  entitiesFound: number;
  entitiesProcessed: number;
  tasksCreated: number;
  tasksFailed: number;
  durationMs: number;
  errorMessage?: string;
  details?: Record<string, unknown>;
}

/**
 * Configuration for polling a specific source
 */
export interface PollingConfig {
  sourceId: string;
  handler: ISourceHandler;
  intervalMinutes: number;
  isActive: boolean;
}

// ─────────────────────────────────────────────
// TASK CREATION TYPES
// ─────────────────────────────────────────────

/**
 * Represents a task rule scope for a specific source
 */
export interface TaskRuleSourceScope {
  id: string;
  taskRuleId: string;
  sourceId: string;
  allowedTypes: string[];
  allowedStatuses: string[];
  assignmentStrategy: string;
  assignmentStrategyConfig?: Record<string, unknown>;
  slaMinutesOverride?: number;
  isActive: boolean;
}

/**
 * Context for creating a task from a source entity
 */
export interface TaskCreationContext {
  source: string;
  sourceEntity: SourceEntity;
  rule: any; // TaskRule from database
  ruleScope: TaskRuleSourceScope;
}

/**
 * Result of task creation
 */
export interface TaskCreationResult {
  taskId: number;
  source: string;
  sourceEntityId: number | string;
  success: boolean;
  error?: string;
}

// ─────────────────────────────────────────────
// API TYPES
// ─────────────────────────────────────────────

/**
 * Request body for registering a new data source
 */
export interface RegisterDataSourceRequest {
  sourceId: string;
  displayName: string;
  description?: string;
  // "DATABASE" | "WEBHOOK" | "API" — the route validates against the
  // DataSourceType enum and falls back to "DATABASE" if omitted.
  pollingType?: "DATABASE" | "WEBHOOK" | "API";
  tableReference: string;
  primaryKeyField: string;
  typeFieldName: string;
  statusFieldName: string;
  queryTemplate: string;
  metadataFieldMapping?: Record<string, string>;
  pollingIntervalMinutes?: number;
  backfillEnabled?: boolean;
  backfillDays?: number;
}

/**
 * Response when registering a data source
 */
export interface RegisterDataSourceResponse {
  id: string;
  sourceId: string;
  displayName: string;
  validationResult: ValidationResult;
  entitiesFound?: number;
  tasksCreated?: number;
}

/**
 * Polling status for a single source
 */
export interface PollingStatus {
  sourceId: string;
  displayName: string;
  isActive: boolean;
  pollingIntervalMinutes: number;
  lastPoll?: {
    startedAt: Date;
    completedAt?: Date;
    status: string;
    entitiesFound: number;
    tasksCreated: number;
    errorMessage?: string;
  };
  recentPolls: Array<{
    startedAt: Date;
    status: string;
    tasksCreated: number;
  }>;
  // Aggregate counts over the last 24h, surfaced as the "Polls: N total · ✓ · ✗"
  // widget on the Data Sources page. 24h window keeps the number bounded vs
  // unbounded lifetime growth.
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
}

// ─────────────────────────────────────────────
// SYNC TYPES
// ─────────────────────────────────────────────

/**
 * Configuration for syncing task status back to source
 */
export interface SyncBackConfig {
  strategy: "NONE" | "API" | "DATABASE" | "WEBHOOK";
  endpoint?: string;
  credentials?: Record<string, unknown>;
}

/**
 * Result of syncing task status to source
 */
export interface SyncBackResult {
  taskId: number;
  sourceEntityId: number | string;
  success: boolean;
  error?: string;
  syncedAt?: Date;
}

// ─────────────────────────────────────────────
// ASSIGNMENT STRATEGY TYPES
// ─────────────────────────────────────────────

/**
 * Assignment strategy handler interface
 */
export interface IAssignmentStrategy {
  name: string;
  assign(
    sourceEntity: SourceEntity,
    config: Record<string, unknown>
  ): Promise<number>; // Returns assigned agent ID
}

export type AssignmentStrategyType =
  | "default"
  | "route_by_store"
  | "round_robin"
  | "geo_based"
  | "priority_based";
