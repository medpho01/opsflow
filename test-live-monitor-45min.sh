#!/bin/bash

# ============================================================================
# LIVE MONITOR: Watch tasks get created for order 3000000
# ============================================================================
# Run this script to monitor task creation as the 45-minute timeline progresses
# Press Ctrl+C to stop monitoring
# ============================================================================

ORDER_ID=3000000
POLL_INTERVAL=30  # Check every 30 seconds

echo "╔═══════════════════════════════════════════════════════════════════════════╗"
echo "║ LIVE TASK MONITORING - Order $ORDER_ID                                    ║"
echo "║ Timeline: 45-minute appointment window                                   ║"
echo "║ Press Ctrl+C to stop                                                     ║"
echo "╚═══════════════════════════════════════════════════════════════════════════╝"
echo ""

# Function to check current order state and tasks
check_status() {
  clear
  echo "📋 LIVE MONITOR - $(date '+%H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  psql postgresql://maverick@localhost:5432/labstack << 'SQL'
-- Order Status
SELECT
  '📦 ORDER STATUS' as section,
  id,
  "orderStatus" as status,
  EXTRACT(EPOCH FROM ("appointmentTime" - NOW()))/60::int as minutes_until_appt,
  EXTRACT(EPOCH FROM (NOW() - "createdAt"))/60::int as minutes_since_created
FROM public."Order"
WHERE id = 3000000;

-- Task Count
SELECT
  '📋 TASK COUNT' as section,
  COUNT(*) as total_tasks,
  COUNT(CASE WHEN status = 'CREATED' THEN 1 END) as created,
  COUNT(CASE WHEN status = 'ASSIGNED' THEN 1 END) as assigned,
  COUNT(CASE WHEN "isArchived" THEN 1 END) as archived
FROM taskos.tasks
WHERE "entityId" = 3000000;

-- Task Details
SELECT
  '✅ TASKS CREATED' as section,
  tr.name as task_name,
  t.status,
  EXTRACT(EPOCH FROM (t."slaDeadline" - NOW()))/60::int as minutes_until_sla
FROM taskos.tasks t
LEFT JOIN taskos.task_rules tr ON tr.id = t."taskRuleId"
WHERE t."entityId" = 3000000
ORDER BY t."createdAt";
SQL

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Next check in $POLL_INTERVAL seconds... (Last updated: $(date '+%H:%M:%S'))"
}

# Expected timeline
echo "📅 EXPECTED TIMELINE:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🔴 IMMEDIATELY (0 min):"
echo "   ✓ Assign Phlebotomist (STATUS rule - creates on ORDER_SCHEDULED)"
echo ""
echo "🟡 AFTER ~15 MINUTES (30 min before appt):"
echo "   ✓ Phlebo Dispatch Check (TIME rule - 30 min BEFORE appointment)"
echo ""
echo "🟢 AFTER ~45 MINUTES (appointment time):"
echo "   ✓ Confirm Sample Collected (TIME rule - 15 min AFTER appointment)"
echo ""
echo "🟠 AFTER ~75 MINUTES (45 min after appointment):"
echo "   ✓ Patient Not Available (TIME rule - 45 min AFTER appointment)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Monitor loop
counter=0
while true; do
  check_status

  counter=$((counter + 1))
  echo "Check #$counter | Waiting $POLL_INTERVAL seconds..."
  sleep $POLL_INTERVAL
done
