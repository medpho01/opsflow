# TaskOS Development Best Practices

**Last Updated**: May 2, 2026

---

## Code Style & Standards

### TypeScript

```typescript
// ✅ GOOD: Explicit types, clear variable names
interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  slaDeadline: Date;
}

const fetchTasks = async (filters: FilterOptions): Promise<Task[]> => {
  // ...
};

// ❌ BAD: Any types, unclear names
const fetchTasks = async (f: any): Promise<any[]> => {
  // ...
};
```

**Rules**:
- No `any` types - use proper types or `unknown` with type guards
- Explicit function return types
- Export interfaces for public APIs
- Use `const` by default, `let` sparingly, never `var`

### Naming Conventions

```typescript
// Variables & Functions: camelCase
const orderStatus = "PENDING";
const handleSubmit = () => {};

// Classes & Types: PascalCase
class TaskManager {}
interface TaskWithContext {}
type OrderStatus = "PENDING" | "COMPLETED";

// Constants: UPPER_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 25;

// Files: kebab-case for components
// task-detail-panel.tsx
// task-rules-builder.tsx
```

### React Components

```typescript
// ✅ GOOD: Functional component with hooks
export const TaskCard = React.memo(({ task, onUpdate }: TaskCardProps) => {
  const [isLoading, setIsLoading] = useState(false);
  
  const handleClick = useCallback(() => {
    onUpdate(task.id);
  }, [task.id, onUpdate]);
  
  return <div onClick={handleClick}>{task.title}</div>;
});

// ❌ BAD: Class component or no memoization
class TaskCard extends React.Component {
  render() {
    return <div>{this.props.task.title}</div>;
  }
}
```

**Rules**:
- Use functional components with hooks
- Memoize components that accept props (`React.memo`)
- Use `useCallback` for event handlers passed as props
- Use `useMemo` for expensive calculations
- One component per file (except for small sub-components)

### Error Handling

```typescript
// ✅ GOOD: Specific error handling
try {
  const tasks = await fetch("/api/tasks");
  if (!tasks.ok) {
    throw new Error(`HTTP ${tasks.status}: ${tasks.statusText}`);
  }
  const data = await tasks.json();
  return data;
} catch (error) {
  console.error("Failed to fetch tasks:", error);
  // Handle appropriately (show toast, return fallback, etc)
  throw error;
}

// ❌ BAD: Swallowing errors
try {
  const tasks = await fetch("/api/tasks");
  return tasks.json();
} catch (error) {
  // Silent failure - no logging, no recovery
}
```

---

## API Design

### Endpoint Structure

```typescript
// ✅ GOOD: RESTful, consistent naming
GET    /api/tasks                      # List with filters
GET    /api/tasks/filters/schema       # Get filter options
GET    /api/tasks/{id}                 # Get single task
POST   /api/tasks                      # Create task
PATCH  /api/tasks/{id}                 # Update task
DELETE /api/tasks/{id}                 # Delete task
PATCH  /api/tasks/bulk                 # Bulk operations

// ❌ BAD: Inconsistent, non-RESTful
GET    /api/get-tasks
GET    /api/fetchFilterSchema
POST   /api/createTask
GET    /api/task_delete?id=123
```

### Request/Response Format

```typescript
// ✅ GOOD: Consistent error format
interface ErrorResponse {
  error: string;
  code: string;
  details?: Record<string, any>;
}

// All errors return consistent structure
{ "error": "Invalid status", "code": "INVALID_STATUS", 
  "details": { "valid": ["CREATED", "ASSIGNED"] } }

// ✅ GOOD: Pagination format
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
```

### Authentication

```typescript
// All protected endpoints require JWT:
export async function GET(request: NextRequest) {
  const user = await getSessionFromRequest(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  
  // Verify role if needed
  if (user.role !== UserRole.OPS_HEAD) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  
  // ... rest of endpoint
}
```

---

## Database Practices

### Prisma Queries

```typescript
// ✅ GOOD: Specify exactly what fields you need
const task = await prisma.task.findUnique({
  where: { id: taskId },
  select: {
    id: true,
    title: true,
    status: true,
    assignedTo: { select: { id: true, name: true } },
  },
});

// ❌ BAD: Loading all fields, unused relations
const task = await prisma.task.findUnique({
  where: { id: taskId },
  include: { // Loads everything
    _count: true,
  },
});
```

### Migrations

```bash
# Create migration
npx prisma migrate dev --name add_feature_name

# Deploy to production
npx prisma migrate deploy

# Always include migration description
# Migration file: prisma/migrations/20260502_add_feature_name/migration.sql
```

### Performance

```typescript
// ✅ GOOD: Batch operations with promise.all
const [tasks, rules, users] = await Promise.all([
  prisma.task.findMany({ where: filters }),
  prisma.taskRule.findMany(),
  prisma.user.findMany(),
]);

// ❌ BAD: Sequential queries (N+1 problem)
const tasks = await prisma.task.findMany();
for (const task of tasks) {
  const rule = await prisma.taskRule.findUnique({
    where: { id: task.ruleId },
  }); // Multiple queries!
}
```

---

## Testing

### Unit Tests

```typescript
describe("calculateSLADeadline", () => {
  it("should add SLA minutes to created time", () => {
    const createdAt = new Date("2026-05-01T10:00:00Z");
    const slaMinutes = 120;
    const expected = new Date("2026-05-01T12:00:00Z");
    
    const actual = calculateSLADeadline(createdAt, slaMinutes);
    expect(actual).toEqual(expected);
  });
  
  it("should handle negative SLA minutes", () => {
    expect(() => calculateSLADeadline(new Date(), -10)).toThrow();
  });
});
```

### Integration Tests

```typescript
describe("GET /api/tasks", () => {
  it("should return filtered tasks with pagination", async () => {
    const response = await fetch("/api/tasks?status=IN_PROGRESS&page=1&pageSize=25");
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.pagination.page).toBe(1);
    expect(Array.isArray(data.data)).toBe(true);
  });
  
  it("should enforce role-based access", async () => {
    const response = await fetch("/api/tasks", {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    // OPS_AGENT should only see own tasks
    expect(data.data.every(t => t.assignedToId === agentId)).toBe(true);
  });
});
```

**Coverage Target**: 80%+ for business logic, 60%+ for UI components

---

## Documentation

### Code Comments

```typescript
// ✅ GOOD: Explain why, not what
// We evaluate rules in order because earlier rules have higher priority
// and might prevent later rules from firing (deduplication)
function evaluateRulesInOrder(rules: TaskRule[]) {
  // ...
}

// ❌ BAD: Comment restates code
// Loop through rules
for (const rule of rules) {
  // increment counter
  count++;
}
```

### Documentation Files

- **New Feature**: Create `/DOCS/features/{feature}/README.md`
- **API Change**: Update relevant `/DOCS/features/*/API_ENDPOINTS.md`
- **Major Change**: Update `/DOCS/ARCHITECTURE.md`
- **Breaking Change**: Document in migration guide

---

## Git Workflow

### Commit Messages

```
✅ GOOD:
feat: Add dynamic enum fetching for order types and statuses
Fetches OrderType and OrderStatus values directly from PostgreSQL
system catalog instead of maintaining Prisma schema replica.
Ensures single source of truth for enum values.

fix: Prevent duplicate task creation for same rule + order
Check existing tasks before creating to avoid duplicates.

docs: Add Task Rules feature documentation

✅ BAD:
fixed bug
update stuff
wip
TODO
```

### Branch Naming

```
feature/name-of-feature          # New features
fix/description-of-fix           # Bug fixes
docs/description-of-change       # Documentation
refactor/description-of-change   # Refactoring
```

---

## Performance Optimization

### Frontend

```typescript
// ✅ GOOD: Debounce filter changes
const handleFilterChange = useDebouncedCallback((filters) => {
  setFilters(filters);
  fetchTasks();
}, 300);

// ✅ GOOD: Virtualize long lists
<VirtualList
  items={tasks}
  height={600}
  itemHeight={50}
  renderItem={renderTaskRow}
/>

// ❌ BAD: Re-render on every keystroke
onChange={(e) => setFilters({ ...filters, search: e.target.value })}
```

### Backend

```typescript
// ✅ GOOD: Use indices for frequent queries
CREATE INDEX idx_task_status ON tasks(status);
CREATE INDEX idx_task_assigned_to ON tasks(assigned_to_id);

// ✅ GOOD: Pagination for large result sets
const pageSize = Math.min(Math.max(req.query.pageSize || 25, 1), 50);
const offset = (page - 1) * pageSize;

// ❌ BAD: Load all records
const allTasks = await prisma.task.findMany(); // Could be 500K+ rows!
```

---

## Security

### Input Validation

```typescript
// ✅ GOOD: Validate all inputs
const { status, priority, pageSize } = req.query;

if (status && !["CREATED", "ASSIGNED", "IN_PROGRESS"].includes(status)) {
  throw new Error("Invalid status");
}

if (pageSize && (pageSize < 1 || pageSize > 50)) {
  throw new Error("PageSize must be 1-50");
}
```

### Sensitive Data

```typescript
// ✅ GOOD: Never log sensitive data
console.log("User created:", { id: user.id, name: user.name });

// ❌ BAD: Never log passwords, tokens, etc
console.log("Auth token:", token);
console.log("User:", user); // Might include password
```

---

## Common Patterns

### Loading State

```typescript
const [isLoading, setIsLoading] = useState(false);

const fetchData = async () => {
  setIsLoading(true);
  try {
    const data = await fetch("/api/data");
    setData(await data.json());
  } catch (error) {
    setError(error.message);
  } finally {
    setIsLoading(false);
  }
};
```

### Timeout Handling

```typescript
// Fetch with timeout
const timeout = (promise, ms) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms)
    ),
  ]);
};

const data = await timeout(fetch("/api/data"), 5000);
```

---

## Review Checklist

Before submitting a PR:

- [ ] Code follows naming conventions
- [ ] Types are explicit (no `any`)
- [ ] Error handling is comprehensive
- [ ] Tests are included and passing
- [ ] Performance-critical code is optimized
- [ ] No console.log statements
- [ ] Documentation is updated
- [ ] Commit messages are clear
- [ ] No security vulnerabilities
- [ ] Database migrations are included (if applicable)

---

**Related**: [ARCHITECTURE.md](ARCHITECTURE.md), Feature-specific testing guides
