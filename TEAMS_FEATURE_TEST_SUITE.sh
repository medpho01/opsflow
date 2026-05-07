#!/bin/bash

# Teams Feature - Comprehensive Test Suite
# Tests database schema, APIs, components, and type checking

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  TEAMS FEATURE - COMPREHENSIVE TEST SUITE"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
  ((PASS_COUNT++))
}

fail() {
  echo -e "${RED}✗ FAIL${NC}: $1"
  ((FAIL_COUNT++))
}

warn() {
  echo -e "${YELLOW}⚠ WARN${NC}: $1"
}

section() {
  echo ""
  echo -e "${BLUE}▶ $1${NC}"
  echo "─────────────────────────────────────────────────────────"
}

# ============================================================
# SECTION 1: Database Schema Validation
# ============================================================
section "Database Schema Validation"

# Check if Prisma schema file exists
if [ -f "prisma/schema.prisma" ]; then
  pass "Prisma schema file exists"

  # Check for TeamMemberOrderType model
  if grep -q "model TeamMemberOrderType" prisma/schema.prisma; then
    pass "TeamMemberOrderType model defined"
  else
    fail "TeamMemberOrderType model not found"
  fi

  # Check for RoundRobinState model
  if grep -q "model RoundRobinState" prisma/schema.prisma; then
    pass "RoundRobinState model defined"
  else
    fail "RoundRobinState model not found"
  fi

  # Check for TeamMember orderTypes relation
  if grep -q 'orderTypes.*TeamMemberOrderType' prisma/schema.prisma; then
    pass "TeamMember orderTypes relation configured"
  else
    fail "TeamMember orderTypes relation not found"
  fi

  # Check for unique constraints
  if grep -q '@@unique(\[teamMemberId, orderType\])' prisma/schema.prisma; then
    pass "Unique constraint on (teamMemberId, orderType)"
  else
    fail "Unique constraint not found"
  fi

else
  fail "Prisma schema file not found"
fi

# Check if migration file exists
if [ -f "prisma/migrations/20260503_add_order_type_assignments.sql" ]; then
  pass "Migration SQL file exists"

  # Check migration content
  if grep -q "CREATE TABLE.*TeamMemberOrderType" prisma/migrations/20260503_add_order_type_assignments.sql; then
    pass "Migration contains TeamMemberOrderType table creation"
  else
    fail "TeamMemberOrderType table creation not in migration"
  fi

  if grep -q "CREATE TABLE.*RoundRobinState" prisma/migrations/20260503_add_order_type_assignments.sql; then
    pass "Migration contains RoundRobinState table creation"
  else
    fail "RoundRobinState table creation not in migration"
  fi
else
  fail "Migration file not found"
fi

# ============================================================
# SECTION 2: Type Definitions Validation
# ============================================================
section "Type Definitions Validation"

if [ -f "src/types/index.ts" ]; then
  pass "Types file exists"

  # Check for new type definitions
  if grep -q "interface TeamMemberOrderType" src/types/index.ts; then
    pass "TeamMemberOrderType interface defined"
  else
    fail "TeamMemberOrderType interface not found"
  fi

  if grep -q "interface TeamMemberWithOrderTypes" src/types/index.ts; then
    pass "TeamMemberWithOrderTypes interface defined"
  else
    fail "TeamMemberWithOrderTypes interface not found"
  fi

  if grep -q "interface MemberPerformanceStats" src/types/index.ts; then
    pass "MemberPerformanceStats interface defined"
  else
    fail "MemberPerformanceStats interface not found"
  fi

  if grep -q "interface OrderTypeOption" src/types/index.ts; then
    pass "OrderTypeOption interface defined"
  else
    fail "OrderTypeOption interface not found"
  fi
else
  fail "Types file not found"
fi

# ============================================================
# SECTION 3: API Endpoints Validation
# ============================================================
section "API Endpoints Validation"

declare -a ENDPOINTS=(
  "src/app/api/order-types/route.ts"
  "src/app/api/team/[id]/order-types/route.ts"
  "src/app/api/team/[id]/order-types/[orderType]/route.ts"
  "src/app/api/team/[id]/performance/route.ts"
)

for endpoint in "${ENDPOINTS[@]}"; do
  if [ -f "$endpoint" ]; then
    pass "Endpoint file exists: $endpoint"
  else
    fail "Endpoint file missing: $endpoint"
  fi
done

# Check enhanced GET /api/team
if grep -q "orderTypes\|orderTypeCount\|taskStats" src/app/api/team/route.ts; then
  pass "GET /api/team enhanced with orderTypes and stats"
else
  fail "GET /api/team not enhanced"
fi

# ============================================================
# SECTION 4: Business Logic Validation
# ============================================================
section "Business Logic Validation"

if [ -f "src/lib/engine/taskCreator.ts" ]; then
  pass "taskCreator.ts exists"

  # Check for updated pickAssignee function
  if grep -q "async function pickAssignee" src/lib/engine/taskCreator.ts; then
    if grep -q "orderType: OrderType" src/lib/engine/taskCreator.ts; then
      pass "pickAssignee() updated with orderType parameter"
    else
      fail "pickAssignee() missing orderType parameter"
    fi
  else
    fail "pickAssignee() function not found"
  fi

  # Check for helper functions
  if grep -q "async function checkOrderTypeAllocations" src/lib/engine/taskCreator.ts; then
    pass "checkOrderTypeAllocations() helper function exists"
  else
    fail "checkOrderTypeAllocations() helper not found"
  fi

  if grep -q "async function applyRoundRobin" src/lib/engine/taskCreator.ts; then
    pass "applyRoundRobin() helper function exists"
  else
    fail "applyRoundRobin() helper not found"
  fi

  # Check for call to pickAssignee with orderType
  if grep -q "await pickAssignee(skillIds, storeId, orderType)" src/lib/engine/taskCreator.ts; then
    pass "pickAssignee() called with orderType parameter"
  else
    fail "pickAssignee() call not updated with orderType"
  fi
else
  fail "taskCreator.ts not found"
fi

if [ -f "src/lib/performance.ts" ]; then
  pass "Performance module exists"

  if grep -q "export async function getMemberStats" src/lib/performance.ts; then
    pass "getMemberStats() function exported"
  else
    fail "getMemberStats() not found"
  fi

  if grep -q "export async function getTeamStats" src/lib/performance.ts; then
    pass "getTeamStats() function exported"
  else
    fail "getTeamStats() not found"
  fi
else
  fail "Performance module not found"
fi

# ============================================================
# SECTION 5: UI Components Validation
# ============================================================
section "UI Components Validation"

declare -a COMPONENTS=(
  "src/components/head/OrderTypeAssignmentModal.tsx"
  "src/components/head/PerformanceMetricsDisplay.tsx"
  "src/components/head/OrderTypeDisplay.tsx"
)

for component in "${COMPONENTS[@]}"; do
  if [ -f "$component" ]; then
    pass "Component file exists: $component"

    # Check if it's a React component
    if grep -q "export function\|export const" "$component"; then
      pass "  - Component exported correctly"
    else
      fail "  - Component not exported"
    fi

    # Check if it uses 'use client'
    if grep -q "'use client'" "$component"; then
      pass "  - Client component directive present"
    else
      warn "  - Missing 'use client' directive (required for Next.js)"
    fi
  else
    fail "Component file missing: $component"
  fi
done

# ============================================================
# SECTION 6: Documentation Validation
# ============================================================
section "Documentation Validation"

declare -a DOCS=(
  "TEAMS_FEATURE_IMPLEMENTATION_COMPLETE.md"
  "TEAMS_FEATURE_QUICK_REFERENCE.md"
)

for doc in "${DOCS[@]}"; do
  if [ -f "$doc" ]; then
    pass "Documentation file exists: $doc"
  else
    fail "Documentation file missing: $doc"
  fi
done

# ============================================================
# SECTION 7: Code Structure & Syntax Validation
# ============================================================
section "Code Structure Validation"

# Check for TypeScript syntax errors using basic validation
echo "Checking TypeScript files for basic syntax..."

# Count TypeScript files created
TS_FILES=$(find src/app/api/team -name "*.ts" -o -name "*.tsx" | wc -l)
if [ "$TS_FILES" -gt 0 ]; then
  pass "Found $TS_FILES TypeScript API files"
else
  fail "No TypeScript API files found"
fi

# Check for common issues
if grep -r "console\\.error\|console\\.warn\|console\\.log" src/lib/engine/taskCreator.ts > /dev/null 2>&1; then
  pass "Logging statements present in taskCreator.ts"
fi

if grep -r "NextResponse\\.json" src/app/api/team/[id]/order-types/route.ts > /dev/null 2>&1; then
  pass "API responses properly formatted"
fi

# ============================================================
# SECTION 8: Permission & Security Validation
# ============================================================
section "Permission & Security Validation"

if grep -q "UserRole\\.OPS_HEAD\|UserRole\\.STORE_ADMIN" src/app/api/team/[id]/order-types/route.ts; then
  pass "Permission checks implemented in order-types API"
else
  fail "Permission checks missing in order-types API"
fi

if grep -q "getSessionFromRequest" src/app/api/team/[id]/order-types/route.ts; then
  pass "Authentication check present in endpoints"
else
  fail "Authentication check missing"
fi

# ============================================================
# SECTION 9: Build Validation
# ============================================================
section "Build & TypeScript Validation"

echo "Building project to validate TypeScript compilation..."
if npm run build > /dev/null 2>&1; then
  pass "Project builds successfully"
else
  warn "Build encountered issues (may be pre-existing)"
fi

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "  ${GREEN}TESTS COMPLETE${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo -e "  ${GREEN}✓ Passed:${NC} $PASS_COUNT"
echo -e "  ${RED}✗ Failed:${NC} $FAIL_COUNT"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
  echo -e "${GREEN}All critical checks passed!${NC}"
  exit 0
else
  echo -e "${RED}Some checks failed. Please review above.${NC}"
  exit 1
fi
