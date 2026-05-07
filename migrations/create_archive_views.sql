-- Create Views for Archive Management and Reporting
-- Purpose: Provide dashboard-friendly views of active vs archived tasks

-- ============================================================================
-- View 1: Active Tasks Only (Primary dashboard view)
-- ============================================================================
-- Use this for ops dashboard - shows only tasks on active/current orders
CREATE OR REPLACE VIEW taskos.v_active_tasks AS
SELECT
    t.id,
    t."entityId",
    t."taskRuleId",
    t."status",
    t."title",
    t."priority",
    t."createdAt",
    t."updatedAt",
    t."assignedToId",
    o.id as order_id,
    o."orderStatus",
    o."appointmentTime",
    u.name as patient_name
FROM taskos.tasks t
LEFT JOIN public."Order" o ON t."entityId" = o.id
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    t."isArchived" = false
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
ORDER BY t."createdAt" DESC;

COMMENT ON VIEW taskos.v_active_tasks IS
'Active tasks only - excludes archived tasks. Use for ops dashboard.';

-- ============================================================================
-- View 2: Archived Tasks (Audit trail view)
-- ============================================================================
-- Use this for audit/history tracking - shows all archived tasks
CREATE OR REPLACE VIEW taskos.v_archived_tasks AS
SELECT
    t.id,
    t."entityId",
    t."taskRuleId",
    t."status",
    t."title",
    t."priority",
    t."createdAt",
    t."updatedAt",
    t."assignedToId",
    o.id as order_id,
    o."orderStatus",
    o."appointmentTime",
    u.name as patient_name
FROM taskos.tasks t
LEFT JOIN public."Order" o ON t."entityId" = o.id
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    t."isArchived" = true
ORDER BY t."updatedAt" DESC;

COMMENT ON VIEW taskos.v_archived_tasks IS
'Archived tasks for audit trail and history. Shows tasks moved out of active view.';

-- ============================================================================
-- View 3: Archive Statistics (For monitoring)
-- ============================================================================
-- Use this for admin dashboard to monitor archive system health
CREATE OR REPLACE VIEW taskos.v_archive_stats AS
SELECT
    'Active Tasks' as category,
    COUNT(*) as count,
    COUNT(*) * 100.0 / (
        SELECT COUNT(*) FROM taskos.tasks WHERE "status" NOT IN ('COMPLETED', 'CANCELLED')
    ) as percentage
FROM taskos.tasks
WHERE
    "isArchived" = false
    AND "status" NOT IN ('COMPLETED', 'CANCELLED')

UNION ALL

SELECT
    'Archived Tasks',
    COUNT(*),
    COUNT(*) * 100.0 / (
        SELECT COUNT(*) FROM taskos.tasks WHERE "status" NOT IN ('COMPLETED', 'CANCELLED')
    )
FROM taskos.tasks
WHERE
    "isArchived" = true

UNION ALL

SELECT
    'Completed Tasks',
    COUNT(*),
    COUNT(*) * 100.0 / (SELECT COUNT(*) FROM taskos.tasks)
FROM taskos.tasks
WHERE
    "status" = 'COMPLETED'

UNION ALL

SELECT
    'Cancelled Tasks',
    COUNT(*),
    COUNT(*) * 100.0 / (SELECT COUNT(*) FROM taskos.tasks)
FROM taskos.tasks
WHERE
    "status" = 'CANCELLED';

COMMENT ON VIEW taskos.v_archive_stats IS
'Archive system statistics for monitoring. Shows distribution of tasks by state.';

-- ============================================================================
-- View 4: Unarchived Potential (Orders that could be archived next cycle)
-- ============================================================================
-- Use this to preview what will be archived on next scheduled run
CREATE OR REPLACE VIEW taskos.v_archive_candidates AS
SELECT
    t.id as task_id,
    t."title",
    t."status",
    t."createdAt",
    o.id as order_id,
    o."appointmentTime",
    EXTRACT(DAY FROM (NOW() - o."appointmentTime")) as days_since_appointment,
    u.name as patient_name
FROM taskos.tasks t
LEFT JOIN public."Order" o ON t."entityId" = o.id
LEFT JOIN public."User" u ON o."userId" = u.id
WHERE
    t."isArchived" = false
    AND t."status" NOT IN ('COMPLETED', 'CANCELLED')
    AND o."appointmentTime" < (NOW() - INTERVAL '10 days')
ORDER BY o."appointmentTime" ASC;

COMMENT ON VIEW taskos.v_archive_candidates IS
'Tasks that will be archived in the next scheduled run (appointmentTime > 10 days old).';
