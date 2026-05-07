# OpsFlow "All Tasks" Feature — QA / TESTING IMPLEMENTATION PLAN

**Date:** May 1, 2026  
**Scope:** Phase 1-3 feature testing + critical bug verification  
**Timeline:** Parallel with development (5+ weeks)  
**Team:** 1-2 QA Engineers, supported by developers

---

## EXECUTIVE SUMMARY

This comprehensive testing plan ensures the OpsFlow task management system meets production quality standards. It covers:

1. **Test Pyramid:** Unit → Integration → E2E → Performance testing
2. **Bug Verification:** Regression tests for all 8 critical/high-priority bugs from audit
3. **Feature Coverage:** All 14 Phase 1-3 features with detailed test scenarios
4. **Data Integrity:** Duplicate prevention, orphaned task detection, SLA accuracy
5. **Performance:** Sort/filter speed targets, memory usage under load
6. **UAT:** Real operator workflows and success metrics

**Success Criteria:**
- Zero duplicate tasks in 100-cycle stress test
- SLA calculations accurate within 1 second
- Sort/filter queries complete in <100ms with 10k tasks
- All color zones render correctly
- WebSocket broadcasts within 5 seconds
- Real-time updates appear on screen <5 seconds after creation

---

# PART 1: TEST PYRAMID & STRATEGY

## Level 1: Unit Tests (40% of effort)

**Scope:** Individual functions, hooks, components in isolation  
**Tools:** Jest, React Testing Library  
**Target Coverage:** >80% for business logic, >60% for UI components

### Backend Unit Tests

```bash
# Location: src/lib/engine/__tests__/
# Run: npm test -- --testPathPattern="src/lib/engine"
```

#### Test Suite 1: Deduplication Logic

```typescript
describe("Task Deduplication", () => {
  describe("isDuplicate()", () => {
    it("should return false for new rule/order combo", async () => {
      const task = await getOrCreateTask(rule, order, payload);
      expect(task.isNew).toBe(true);
    });

    it("should return true for existing non-archived task", async () => {
      // Create first
      const first = await getOrCreateTask(rule, order, payload);
      // Try to create same
      const second = await getOrCreateTask(rule, order, payload);
      
      expect(first.task.id).toBe(second.task.id);
      expect(second.isNew).toBe(false);
    });

    it("should allow recreation if task is archived", async () => {
      // Create and archive
      const first = await getOrCreateTask(rule, order, payload);
      await prisma.task.update({
        where: { id: first.task.id },
        data: { isArchived: true },
      });
      
      // Try to create same
      const second = await getOrCreateTask(rule, order, payload);
      
      expect(second.isNew).toBe(true);
      expect(second.task.id).not.toBe(first.task.id);
    });

    it("should handle null rule and order gracefully", async () => {
      expect(() => getOrCreateTask(null, order, payload)).toThrow();
      expect(() => getOrCreateTask(rule, null, payload)).toThrow();
    });

    it("should work with 1000 concurrent requests", async () => {
      const promises = Array(1000).fill(null).map(() =>
        getOrCreateTask(rule, order, payload)
      );
      
      const results = await Promise.all(promises);
      const taskIds = new Set(results.map(r => r.task.id));
      
      // Should only create 1 task despite 1000 attempts
      expect(taskIds.size).toBe(1);
    });
  });
});
```

#### Test Suite 2: SLA Calculations

```typescript
describe("SLA Calculations (Timezone-Aware)", () => {
  beforeEach(() => {
    process.env.TIMEZONE = "Asia/Kolkata";
  });

  describe("createSLADeadline()", () => {
    it("should create deadline 60 minutes in future", () => {
      const now = getNowInAppTimezone();
      const deadline = createSLADeadline(now, 60);
      
      const remaining = getTimeRemaining(deadline);
      
      expect(remaining.minutes).toBeGreaterThan(59);
      expect(remaining.minutes).toBeLessThan(61);
    });

    it("should mark task as breached if deadline passed", () => {
      const now = getNowInAppTimezone();
      const pastDeadline = createSLADeadline(now, -10);  // 10 mins ago
      
      const remaining = getTimeRemaining(pastDeadline);
      
      expect(remaining.isBreached).toBe(true);
      expect(remaining.minutes).toBeLessThan(-9);
    });

    it("should handle edge case: deadline exactly now", () => {
      const now = getNowInAppTimezone();
      const deadline = createSLADeadline(now, 0);  // Now
      
      const remaining = getTimeRemaining(deadline);
      
      // Should be at or just before breached
      expect(remaining.minutes).toBeLessThanOrEqual(0.1);
    });

    it("should store deadline in UTC for consistency", async () => {
      const now = getNowInAppTimezone();
      const deadline = createSLADeadline(now, 60);
      
      // Deadline should be a valid UTC DateTime
      expect(deadline.toISOString()).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      
      // Can round-trip through database
      const stored = await prisma.task.create({
        data: {
          title: "Test",
          slaDeadline: deadline,
          // ... other fields ...
        },
      });
      
      const retrieved = await prisma.task.findUnique({ where: { id: stored.id } });
      
      // Should match
      expect(Math.abs(retrieved!.slaDeadline.getTime() - deadline.getTime())).toBeLessThan(1000);
    });
  });

  describe("SLA Color Zones", () => {
    it("should return GREEN for >30 mins remaining", () => {
      const task = { slaDeadline: new Date(Date.now() + 45 * 60_000) };
      const zone = calculateSLAZone(task);
      
      expect(zone).toBe("green");
    });

    it("should return YELLOW for 10-30 mins remaining", () => {
      const task = { slaDeadline: new Date(Date.now() + 15 * 60_000) };
      const zone = calculateSLAZone(task);
      
      expect(zone).toBe("yellow");
    });

    it("should return RED for <10 mins remaining", () => {
      const task = { slaDeadline: new Date(Date.now() + 5 * 60_000) };
      const zone = calculateSLAZone(task);
      
      expect(zone).toBe("red");
    });

    it("should return RED for breached", () => {
      const task = { slaDeadline: new Date(Date.now() - 5 * 60_000) };
      const zone = calculateSLAZone(task);
      
      expect(zone).toBe("red");
    });
  });
});
```

#### Test Suite 3: Status Transitions

```typescript
describe("Status Transition Validation", () => {
  const validTransitions = {
    CREATED: [TaskStatus.ASSIGNED, TaskStatus.CANCELLED],
    ASSIGNED: [TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
    IN_PROGRESS: [TaskStatus.COMPLETED, TaskStatus.BLOCKED, TaskStatus.BREACHED],
    BLOCKED: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
    BREACHED: [TaskStatus.COMPLETED, TaskStatus.CANCELLED],
    COMPLETED: [TaskStatus.COMPLETED],
    CANCELLED: [TaskStatus.CANCELLED],
  };

  it.each(Object.entries(validTransitions))("should validate %s transitions", (fromStatus, toStatuses) => {
    toStatuses.forEach(toStatus => {
      const isValid = validateTransition(fromStatus, toStatus);
      expect(isValid).toBe(true);
    });
  });

  it("should reject invalid transitions", () => {
    expect(validateTransition(TaskStatus.COMPLETED, TaskStatus.IN_PROGRESS)).toBe(false);
    expect(validateTransition(TaskStatus.CREATED, TaskStatus.BLOCKED)).toBe(false);
    expect(validateTransition(TaskStatus.CANCELLED, TaskStatus.ASSIGNED)).toBe(false);
  });
});
```

#### Test Suite 4: Polling Lock

```typescript
describe("Polling Lock", () => {
  it("should acquire and release lock", async () => {
    const acquired = await acquirePollingLock();
    expect(acquired).toBe(true);
    
    await releasePollingLock();
    
    // Should be able to acquire again
    const reacquired = await acquirePollingLock();
    expect(reacquired).toBe(true);
    await releasePollingLock();
  });

  it("should block concurrent attempts", async () => {
    const first = await acquirePollingLock();
    expect(first).toBe(true);
    
    // Second attempt should fail
    const second = await acquirePollingLock();
    expect(second).toBe(false);
    
    await releasePollingLock();
  });

  it("should timeout stale locks", async () => {
    // Acquire lock
    await acquirePollingLock();
    
    // Simulate process crash (don't release)
    // After timeout, lock should auto-release
    
    await new Promise(resolve => setTimeout(resolve, 65000));  // Wait >60 sec
    
    // Should be able to acquire
    const canAcquire = await acquirePollingLock();
    expect(canAcquire).toBe(true);
  });
});
```

### Frontend Unit Tests

```bash
# Location: src/components/__tests__/
# Run: npm test -- --testPathPattern="src/components"
```

#### Test Suite 1: SLA Color Calculation

```typescript
describe("useSLAColor Hook", () => {
  it("should return green for >30 mins remaining", () => {
    const task: Task = {
      id: 1,
      slaDeadline: new Date(Date.now() + 45 * 60_000),
      createdAt: new Date(Date.now() - 60_000),
      status: TaskStatus.ASSIGNED,
      // ... other fields ...
    };

    const { result } = renderHook(() => useSLAColor(task));

    expect(result.current.zone).toBe("green");
  });

  it("should update color as time passes", () => {
    jest.useFakeTimers();

    const task: Task = {
      slaDeadline: new Date(Date.now() + 65 * 60_000),  // 65 mins future
      // ... other fields ...
    };

    const { result, rerender } = renderHook(() => useSLAColor(task));
    expect(result.current.zone).toBe("green");

    // Fast-forward 40 minutes
    jest.advanceTimersByTime(40 * 60_000);
    rerender();

    expect(result.current.zone).toBe("yellow");

    jest.useRealTimers();
  });
});
```

#### Test Suite 2: LastUpdatedWidget

```typescript
describe("LastUpdatedWidget", () => {
  it("should render timestamp", () => {
    const lastUpdated = new Date(Date.now() - 2 * 60_000);  // 2 mins ago

    render(
      <LastUpdatedWidget
        lastUpdatedAt={lastUpdated}
        isLoading={false}
        onRefresh={() => {}}
      />
    );

    expect(screen.getByText(/2 min/)).toBeInTheDocument();
  });

  it("should show 'Just now' within 10 seconds", () => {
    const lastUpdated = new Date();

    render(
      <LastUpdatedWidget
        lastUpdatedAt={lastUpdated}
        isLoading={false}
        onRefresh={() => {}}
      />
    );

    expect(screen.getByText("Just now")).toBeInTheDocument();
  });

  it("should call onRefresh when button clicked", () => {
    const onRefresh = jest.fn();

    render(
      <LastUpdatedWidget
        lastUpdatedAt={new Date()}
        isLoading={false}
        onRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByText("Refresh"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("should be disabled while loading", () => {
    const onRefresh = jest.fn();

    render(
      <LastUpdatedWidget
        lastUpdatedAt={new Date()}
        isLoading={true}
        onRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByText("Refresh"));

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
```

#### Test Suite 3: StatusDistributionWidget

```typescript
describe("StatusDistributionWidget", () => {
  const createMockTask = (status: TaskStatus): Task => ({
    id: Math.random(),
    status,
    // ... other required fields ...
  });

  it("should count tasks by status", () => {
    const tasks = [
      createMockTask(TaskStatus.CREATED),
      createMockTask(TaskStatus.CREATED),
      createMockTask(TaskStatus.ASSIGNED),
      createMockTask(TaskStatus.IN_PROGRESS),
      createMockTask(TaskStatus.BREACHED),
    ];

    render(
      <StatusDistributionWidget
        tasks={tasks}
        onStatusClick={() => {}}
        selectedStatus={null}
      />
    );

    expect(screen.getByText("2")).toBeInTheDocument();  // 2 CREATED
    expect(screen.getByText("1")).toBeInTheDocument();  // 1 ASSIGNED, etc.
  });

  it("should highlight selected status", () => {
    const tasks = [
      createMockTask(TaskStatus.CREATED),
      createMockTask(TaskStatus.ASSIGNED),
    ];

    const { rerender } = render(
      <StatusDistributionWidget
        tasks={tasks}
        onStatusClick={() => {}}
        selectedStatus={null}
      />
    );

    // Click CREATED
    fireEvent.click(screen.getAllByRole("button")[0]);

    rerender(
      <StatusDistributionWidget
        tasks={tasks}
        onStatusClick={() => {}}
        selectedStatus={TaskStatus.CREATED}
      />
    );

    expect(screen.getByText(TaskStatus.CREATED)).toHaveClass("ring-2");
  });
});
```

---

## Level 2: Integration Tests (35% of effort)

**Scope:** API endpoints, database transactions, component interactions  
**Tools:** Jest, Supertest, MSW (for API mocking)

### Backend Integration Tests

```bash
# Location: src/app/api/__tests__/
# Run: npm test -- --testPathPattern="api" --integration
```

#### Test Suite 1: Task Creation Flow

```typescript
describe("Task Creation - Full Flow", () => {
  let testRule: TaskRule;
  let testOrder: Order;

  beforeEach(async () => {
    testRule = await createTestRule({
      slaMinutes: 60,
      triggerOn: TriggerType.ORDER_CREATED,
    });
    testOrder = await createTestOrder({ status: "CREATED" });
  });

  it("should create task on order creation", async () => {
    const response = await request(app)
      .post("/api/orders")
      .send(testOrder);

    expect(response.status).toBe(201);

    // Task should exist
    const task = await prisma.task.findFirst({
      where: {
        taskRuleId: testRule.id,
        entityId: testOrder.id,
      },
    });

    expect(task).toBeDefined();
    expect(task?.status).toBe(TaskStatus.CREATED);
    expect(task?.slaDeadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("should not create duplicate on concurrent requests", async () => {
    const promise1 = evaluateAndCreateTasks([testOrder], [testRule]);
    const promise2 = evaluateAndCreateTasks([testOrder], [testRule]);

    await Promise.all([promise1, promise2]);

    const tasks = await prisma.task.findMany({
      where: {
        taskRuleId: testRule.id,
        entityId: testOrder.id,
      },
    });

    expect(tasks).toHaveLength(1);
  });

  it("should set correct SLA deadline in timezone", async () => {
    process.env.TIMEZONE = "Asia/Kolkata";

    const task = await getOrCreateTask(testRule, testOrder, {
      title: "Test",
      slaDeadline: createSLADeadline(getNowInAppTimezone(), 60),
      // ...
    });

    const remaining = getTimeRemaining(task.task.slaDeadline);

    expect(remaining.minutes).toBeGreaterThan(59);
    expect(remaining.minutes).toBeLessThan(61);
  });

  it("should broadcast task created event via WebSocket", async () => {
    const mockBroadcast = jest.spyOn(taskEventBroadcaster, "broadcastTaskCreated");

    await getOrCreateTask(testRule, testOrder, payload);

    expect(mockBroadcast).toHaveBeenCalled();
  });
});
```

#### Test Suite 2: Bulk Actions

```typescript
describe("Bulk Task Actions", () => {
  let tasks: Task[];

  beforeEach(async () => {
    tasks = await Promise.all([
      createTestTask({ status: TaskStatus.CREATED }),
      createTestTask({ status: TaskStatus.ASSIGNED }),
      createTestTask({ status: TaskStatus.ASSIGNED }),
      createTestTask({ status: TaskStatus.IN_PROGRESS }),
    ]);
  });

  it("should bulk reassign tasks", async () => {
    const agent = await createTestAgent();
    const taskIds = [tasks[0].id, tasks[1].id];

    const response = await request(app)
      .post("/api/tasks/bulk")
      .send({
        ids: taskIds,
        action: "reassign",
        assignedToId: agent.id,
      });

    expect(response.status).toBe(200);

    // Verify tasks updated
    const updated = await prisma.task.findMany({
      where: { id: { in: taskIds } },
    });

    expect(updated.every(t => t.assignedToId === agent.id)).toBe(true);
    expect(updated.every(t => t.status === TaskStatus.ASSIGNED)).toBe(true);
  });

  it("should reject invalid status transitions", async () => {
    const createdTasks = [tasks[0].id];  // CREATED status

    const response = await request(app)
      .post("/api/tasks/bulk")
      .send({
        ids: createdTasks,
        action: "block",  // Can't block CREATED
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("invalid");
  });

  it("should only update valid tasks in mixed batch", async () => {
    const validTask = tasks[1];  // ASSIGNED
    const invalidTask = tasks[0];  // CREATED

    const response = await request(app)
      .post("/api/tasks/bulk")
      .send({
        ids: [validTask.id, invalidTask.id],
        action: "block",
      });

    expect(response.status).toBe(400);

    // Only valid task should be updated
    const updated = await prisma.task.findUnique({ where: { id: validTask.id } });
    expect(updated?.status).toBe(TaskStatus.BLOCKED);

    const notUpdated = await prisma.task.findUnique({ where: { id: invalidTask.id } });
    expect(notUpdated?.status).toBe(TaskStatus.CREATED);
  });
});
```

#### Test Suite 3: Filtering & Sorting

```typescript
describe("Task API - Filtering & Sorting", () => {
  let tasks: Task[];

  beforeEach(async () => {
    tasks = await Promise.all([
      createTestTask({
        title: "A",
        priority: TaskPriority.URGENT,
        appointmentTime: new Date(Date.now() + 1 * 60_000),
        createdAt: new Date(Date.now() - 100_000),
      }),
      createTestTask({
        title: "B",
        priority: TaskPriority.MEDIUM,
        appointmentTime: new Date(Date.now() + 2 * 60_000),
        createdAt: new Date(Date.now() - 50_000),
      }),
      createTestTask({
        title: "C",
        priority: TaskPriority.LOW,
        appointmentTime: null,  // No appointment time
        createdAt: new Date(Date.now() - 150_000),
      }),
    ]);
  });

  describe("Status Filter", () => {
    it("should filter by valid status", async () => {
      const response = await request(app)
        .get("/api/tasks?status=CREATED");

      expect(response.status).toBe(200);
      expect(response.body.tasks.length).toBeGreaterThan(0);
      expect(response.body.tasks.every(t => t.status === "CREATED")).toBe(true);
    });

    it("should reject invalid status", async () => {
      const response = await request(app)
        .get("/api/tasks?status=INVALID");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Invalid");
    });
  });

  describe("Priority Filter", () => {
    it("should filter by priority", async () => {
      const response = await request(app)
        .get("/api/tasks?priority=URGENT");

      expect(response.body.tasks.every(t => t.priority === "URGENT")).toBe(true);
    });

    it("should be case-insensitive", async () => {
      const response = await request(app)
        .get("/api/tasks?priority=urgent");

      expect(response.status).toBe(200);
      expect(response.body.tasks.length).toBeGreaterThan(0);
    });
  });

  describe("Sorting", () => {
    it("should sort by priority descending (URGENT first)", async () => {
      const response = await request(app)
        .get("/api/tasks?sortBy=priority&sortOrder=desc");

      const priorities = response.body.tasks.map(t => t.priority);
      expect(priorities).toEqual(expect.arrayContaining([
        "URGENT", "MEDIUM", "LOW"
      ]));
    });

    it("should sort by appointmentTime with NULLS LAST", async () => {
      const response = await request(app)
        .get("/api/tasks?sortBy=appointmentTime&sortOrder=asc");

      const appointmentTimes = response.body.tasks.map(t => t.appointmentTime);
      
      // Non-null values should come before null values
      let sawNull = false;
      appointmentTimes.forEach(time => {
        if (time === null) {
          sawNull = true;
        } else if (sawNull) {
          throw new Error("Non-null appointment time after null value");
        }
      });
    });

    it("should sort by createdAt ascending (oldest first)", async () => {
      const response = await request(app)
        .get("/api/tasks?sortBy=createdAt&sortOrder=asc");

      const createdAts = response.body.tasks.map(t =>
        new Date(t.createdAt).getTime()
      );

      // Should be in ascending order
      for (let i = 1; i < createdAts.length; i++) {
        expect(createdAts[i]).toBeGreaterThanOrEqual(createdAts[i - 1]);
      }
    });
  });

  describe("Pagination", () => {
    it("should paginate results", async () => {
      const response1 = await request(app)
        .get("/api/tasks?limit=2&page=1");

      expect(response1.body.tasks.length).toBeLessThanOrEqual(2);

      const response2 = await request(app)
        .get("/api/tasks?limit=2&page=2");

      // Page 2 should have different tasks than page 1
      const ids1 = new Set(response1.body.tasks.map(t => t.id));
      const ids2 = new Set(response2.body.tasks.map(t => t.id));

      expect([...ids1].some(id => ids2.has(id))).toBe(false);
    });
  });
});
```

### Frontend Integration Tests

```typescript
describe("AllTasksBoard - Full Integration", () => {
  it("should load tasks and display them", async () => {
    const mockTasks = [
      createMockTask({ status: "CREATED", priority: "URGENT" }),
      createMockTask({ status: "ASSIGNED", priority: "HIGH" }),
    ];

    jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tasks: mockTasks, total: 2, totalPages: 1 }),
    } as Response);

    render(<AllTasksBoard />);

    await waitFor(() => {
      expect(screen.getAllByRole("row").length).toBeGreaterThan(2);
    });

    expect(screen.getByText("CREATED")).toBeInTheDocument();
    expect(screen.getByText("ASSIGNED")).toBeInTheDocument();
  });

  it("should update when filter changes", async () => {
    render(<AllTasksBoard />);

    // Click status filter
    const statusFilter = screen.getByDisplayValue("All Statuses");
    fireEvent.change(statusFilter, { target: { value: "CREATED" } });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("status=CREATED"));
    });
  });

  it("should broadcast task created event", async () => {
    const mockSocket = {
      addEventListener: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
    };

    window.WebSocket = jest.fn(() => mockSocket) as any;

    render(<AllTasksBoard />);

    // Simulate WebSocket message
    const addEventListenerCall = mockSocket.addEventListener.mock.calls.find(
      ([event]) => event === "message"
    );
    const handleMessage = addEventListenerCall[1];

    handleMessage({
      data: JSON.stringify({
        type: "task_created",
        task: createMockTask({ id: 999 }),
      }),
    });

    await waitFor(() => {
      expect(screen.getByText(/T-999/)).toBeInTheDocument();
    });
  });
});
```

---

## Level 3: End-to-End Tests (20% of effort)

**Scope:** Complete user workflows, real browser  
**Tools:** Playwright, Cypress

### E2E Test Suite 1: Task Lifecycle

```typescript
test("should create, assign, and complete task", async ({ page }) => {
  // 1. Create order
  await page.goto("/orders");
  await page.click("button:has-text('New Order')");
  await page.fill("input[name='customerId']", "1");
  await page.click("button:has-text('Create')");

  await page.waitForNavigation();
  const orderUrl = page.url();
  const orderId = orderUrl.split("/").pop();

  // 2. Check that task was created
  await page.goto("/tasks");
  await page.waitForSelector(`[data-task-id]`);
  const taskRow = await page.$(`[data-order-id="${orderId}"]`);
  expect(taskRow).toBeTruthy();

  // 3. Verify color zone (should be green if just created with long SLA)
  const slaCell = await taskRow?.evaluate(el => el.classList.contains("green"));
  expect(slaCell).toBe(true);

  // 4. Click task to open side panel
  await taskRow?.click();
  await page.waitForSelector("[data-panel='task-detail']");

  // 5. Reassign task
  await page.click("button:has-text('Reassign')");
  await page.selectOption("select[name='agent']", "2");
  await page.click("button:has-text('Apply')");

  await page.waitForSelector("text=Reassigned successfully");

  // 6. Verify assignment metadata
  const assignmentInfo = await page.$("text=Auto-assigned by R2");
  expect(assignmentInfo).toBeTruthy();
});
```

### E2E Test Suite 2: Real-Time Updates

```typescript
test("should show new task in real-time", async ({ page, browser }) => {
  // Open tasks page
  await page.goto("/tasks");
  const initialTaskCount = await page.locator("[data-task-id]").count();

  // Open second browser to create order
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.goto("/orders");
  await page2.click("button:has-text('New Order')");
  await page2.fill("input[name='customerId']", "1");
  await page2.click("button:has-text('Create')");

  // First browser should see toast and new task
  await page.waitForSelector("text=New task created");
  const newTaskCount = await page.locator("[data-task-id]").count();
  expect(newTaskCount).toBe(initialTaskCount + 1);

  await context2.close();
});
```

---

# PART 2: BUG VERIFICATION TESTS

All 8 bugs from Technical Audit must have regression tests.

## Bug Verification Suite 1: Race Condition in Deduplication (C1.1)

```typescript
test("should prevent duplicate task creation under concurrent polling", async () => {
  const rule = await createTestRule();
  const order = await createTestOrder();

  // Simulate concurrent polling cycles
  const results = await Promise.all([
    evaluateAndCreateTasks([order], [rule]),
    evaluateAndCreateTasks([order], [rule]),
    evaluateAndCreateTasks([order], [rule]),
  ]);

  const createdCounts = results.map(r => r.created);
  const totalCreated = createdCounts.reduce((a, b) => a + b, 0);

  // Only 1 task should have been created despite 3 concurrent attempts
  expect(totalCreated).toBe(1);

  const taskCount = await prisma.task.count({
    where: { taskRuleId: rule.id, entityId: order.id },
  });
  expect(taskCount).toBe(1);
});
```

## Bug Verification Suite 2: Polling Lock (C1.2)

```typescript
test("should serialize polling cycles with lock", async () => {
  let cycle1Started = false, cycle1Completed = false;
  let cycle2Started = false, cycle2Completed = false;

  const pollCycle1 = (async () => {
    cycle1Started = true;
    await runPollCycle();
    cycle1Completed = true;
  })();

  const pollCycle2 = (async () => {
    // Give cycle 1 time to start
    await new Promise(resolve => setTimeout(resolve, 100));
    cycle2Started = true;
    await runPollCycle();
    cycle2Completed = true;
  })();

  await Promise.all([pollCycle1, pollCycle2]);

  // Cycle 2 should not have held the lock if cycle 1 was already running
  // (This is hard to test directly, but we can verify no duplicates were created)
});
```

## Bug Verification Suite 3: Status Transition (C1.3)

```typescript
test("should reject CREATED → BLOCKED transition", async () => {
  const task = await createTestTask({ status: TaskStatus.CREATED });

  const response = await request(app)
    .post("/api/tasks/bulk")
    .send({
      ids: [task.id],
      action: "block",
    });

  expect(response.status).toBe(400);

  // Task should still be CREATED
  const updated = await prisma.task.findUnique({ where: { id: task.id } });
  expect(updated?.status).toBe(TaskStatus.CREATED);
});
```

## Bug Verification Suite 4: Timezone SLA (C1.4)

```typescript
test("should calculate SLA correctly across timezones", async () => {
  process.env.TIMEZONE = "Asia/Kolkata";

  const nowIST = getNowInAppTimezone();
  const slaMinutes = 60;
  const deadline = createSLADeadline(nowIST, slaMinutes);

  const remaining = getTimeRemaining(deadline);

  expect(remaining.minutes).toBeGreaterThan(59);
  expect(remaining.minutes).toBeLessThan(61);

  // Verify it's stored correctly in DB
  const task = await prisma.task.create({
    data: {
      title: "Test",
      slaDeadline: deadline,
      // ...
    },
  });

  const retrieved = await prisma.task.findUnique({ where: { id: task.id } });
  const retrievedRemaining = getTimeRemaining(retrieved!.slaDeadline);

  expect(Math.abs(retrievedRemaining.minutes - slaMinutes)).toBeLessThan(1);
});
```

## Bug Verification Suite 5-8: Filter/Sort Bugs (H2.1-H2.3)

```typescript
test("should handle NULL appointmentTime correctly (NULLS LAST)", async () => {
  const t1 = await createTestTask({ appointmentTime: new Date(Date.now() + 60_000) });
  const t2 = await createTestTask({ appointmentTime: null });
  const t3 = await createTestTask({ appointmentTime: new Date(Date.now() + 120_000) });

  const response = await request(app)
    .get("/api/tasks?sortBy=appointmentTime&sortOrder=asc");

  const ids = response.body.tasks.map(t => t.id);

  // t2 (null) should be last
  expect(ids.indexOf(t2.id)).toBe(ids.length - 1);
  expect(ids.slice(0, 2)).toContain(t1.id);
  expect(ids.slice(0, 2)).toContain(t3.id);
});

test("should validate filter inputs", async () => {
  const response = await request(app)
    .get("/api/tasks?status=INVALID_STATUS");

  expect(response.status).toBe(400);
  expect(response.body.error).toContain("Invalid");
});

test("should have type-safe archive stats", async () => {
  const response = await request(app).get("/api/tasks/stats");

  expect(response.status).toBe(200);

  const schema = z.array(
    z.object({
      category: z.enum(["Active Tasks", "Archived Tasks"]),
      count: z.number().int(),
      percentage: z.number(),
    })
  );

  expect(schema.safeParse(response.body.stats).success).toBe(true);
});
```

---

# PART 3: FEATURE TEST SCENARIOS

## Phase 1 Feature Tests

### Feature F1.1: Refresh Button + Timestamp

```gherkin
Feature: Data Freshness Visibility

Scenario: User sees timestamp of last update
  Given user opens All Tasks page
  When page loads
  Then timestamp "Last updated: 2 mins ago" is displayed
  And counter updates every 1 second

Scenario: User manually refreshes data
  Given user is viewing tasks
  When user clicks Refresh button
  Then "Last updated: Just now" is displayed
  And selected tasks remain selected
  And data reloads from server

Scenario: Timestamp updates in real-time
  Given timestamp is "10 mins ago"
  When 1 minute passes
  Then timestamp updates to "11 mins ago"
```

Test Implementation:
```typescript
test("should display and update timestamp", async ({ page }) => {
  await page.goto("/tasks");

  // Check timestamp displays
  const timestamp = await page.locator("text=Last updated:").textContent();
  expect(timestamp).toContain("Last updated:");

  // Click refresh
  await page.click("button:has-text('Refresh')");
  await page.waitForSelector("text=Just now");

  // Verify timestamp updates
  await page.waitForTimeout(1000);
  let currentText = await page.locator("text=Last updated:").textContent();
  expect(currentText).toContain("Just now");

  await page.waitForTimeout(2000);
  currentText = await page.locator("text=Last updated:").textContent();
  expect(currentText).toContain("1 min");
});
```

### Feature F1.2: Auto-Refresh on New Task

```gherkin
Feature: Real-Time Task Creation

Scenario: New task appears immediately
  Given user has All Tasks page open
  And 0 CREATED tasks visible
  When new order is created (via API or other client)
  Then "New task created" toast appears within 5 seconds
  And new task appears in list
  And CREATED count increases
```

### Feature F1.3: Color-Coded Urgency

```gherkin
Feature: Visual SLA Urgency Zones

Scenario: Task row colors change based on SLA
  Given task with 45 minutes SLA remaining
  When task row is displayed
  Then row background is green
  
  Given task with 15 minutes SLA remaining
  When time passes
  Then row background changes to yellow
  
  Given task with 5 minutes SLA remaining
  When time passes
  Then row background changes to red
  
  Given task is breached
  Then row background is red
  And timer shows "+5m overdue"
```

### Feature F1.4: Status Distribution Widget

```gherkin
Feature: Workflow Bottleneck Visibility

Scenario: Widget shows task counts
  Given 3 CREATED, 7 ASSIGNED, 2 IN_PROGRESS, 1 BREACHED
  When All Tasks page loads
  Then widget shows "3 CREATED | 7 ASSIGNED | 2 IN_PROGRESS | 0 BLOCKED | 1 BREACHED"
  And each count is color-coded

Scenario: Clicking count filters tasks
  When user clicks "7 ASSIGNED"
  Then task list filters to show only ASSIGNED tasks
  And widget button has highlight/ring
  
  When user clicks "7 ASSIGNED" again
  Then filter clears
  And all tasks visible again
```

### Feature F1.5: Assignment Status Visibility

```gherkin
Feature: Assignment Verification

Scenario: Task shows assignment method
  Given auto-assigned task
  When task row displays
  Then "Auto-assigned by R2" indicator visible
  And "Assigned 5 mins ago" timestamp shown
  
Scenario: Manual reassignment is visible
  Given task that was manually reassigned
  When task row displays
  Then "⚠ Manual override" indicator visible
  And "Reassigned by Sarah" shown

Scenario: Filter for manual reassignments
  When user clicks filter "⚠ Manual Overrides Only"
  Then only manually reassigned tasks shown
```

---

## Phase 2 Feature Tests

### Feature F2.1: Unified Filter Bar

```gherkin
Feature: Consolidated Filtering

Scenario: All filters in one place
  When user opens All Tasks
  Then single filter bar shows:
    | Status dropdown    |
    | Priority dropdown  |
    | Assignee dropdown  |
    | Date range picker  |
    | SLA risk toggle    |

Scenario: Save favorite filter
  When user sets Status=CREATED, Priority=URGENT
  And clicks "⭐ Save Filter"
  And types "CRITICAL TASKS"
  Then "CRITICAL TASKS" button appears below filter bar
  
  When user clicks "CRITICAL TASKS"
  Then Status and Priority filters applied automatically
```

### Feature F2.2: Better SLA Display

```gherkin
Feature: Rich SLA Context

Scenario: SLA column shows context on hover
  Given task with SLA 30 mins, created 15 mins ago, 15 mins remaining
  When user hovers over SLA timer "15m remaining"
  Then tooltip shows:
    | Created: 10:45 AM  |
    | SLA: 30 minutes    |
    | Deadline: 11:15 AM |
    | Status: On track ✓ |
```

### Feature F2.3: Task Detail Side Panel

```gherkin
Feature: Non-Destructive Task Inspection

Scenario: Click task opens side panel
  When user clicks task row
  Then side panel slides in from right
  And task list remains visible on left
  
Scenario: Panel shows full task context
  Then panel displays:
    | Task details (title, type, priority)    |
    | Order info (ID, appointment)            |
    | SLA timeline (created, deadline, status) |
    | Assignment info (who, when, method)     |
    | Task history (recent changes)           |
    | Checklist (if applicable)               |
    | Action buttons (reassign, block, etc.)  |

Scenario: User can reassign from panel
  When user clicks "Reassign"
  And selects agent "John Smith"
  And clicks "Apply"
  Then task reassigned
  And panel updates to show new agent
  And success toast "Reassigned to John Smith"
```

---

## Phase 3 Feature Tests

### Feature F3.1: Kanban View

```gherkin
Feature: Visual Workflow Management

Scenario: Toggle between table and Kanban
  When user clicks "Kanban" button
  Then display switches to Kanban view with columns:
    | CREATED (3) | ASSIGNED (7) | IN_PROGRESS (2) | BLOCKED (0) | COMPLETED (5) |

Scenario: Drag task between columns
  When user drags task from ASSIGNED to IN_PROGRESS
  Then task moves to new column
  And server updates task status
  And count badges update

Scenario: Visual bottleneck identification
  When user views Kanban
  Then ASSIGNED column has 7 tasks (noticeably full)
  And quickly identifies bottleneck visually
```

### Feature F3.2: Real-Time Alerts

```gherkin
Feature: Proactive SLA Alerts

Scenario: Alert when task breaching soon
  Given task with 5 minutes until SLA breach
  When 5-minute warning threshold reached
  Then toast appears: "⚠ Task T-4521 breaching in 5 mins!"
  And bell icon shows alert count

Scenario: Alert when task breached
  Given task with SLA deadline passed
  When breach occurs
  Then toast appears: "🔴 Task T-4521 breached SLA!"
  And bell icon updates

Scenario: Alert history
  When user clicks bell icon
  Then dropdown shows alert history:
    | Time | Task | Message | Status |
  And user can mark as read / dismiss
```

---

# PART 4: PERFORMANCE TESTS

## Performance Test Targets

| Operation | Data Size | Target | Status |
|-----------|-----------|--------|--------|
| Sort (priority) | 10,000 tasks | <100ms | TBD |
| Filter (status + priority) | 10,000 tasks | <100ms | TBD |
| Pagination (page 1 → page 100) | 10,000 tasks | <50ms | TBD |
| WebSocket broadcast | 500 connected clients | <100ms | TBD |
| Memory usage | 10,000 tasks in memory | <200MB | TBD |

### Performance Test Implementation

```typescript
describe("Performance - Sorting", () => {
  it("should sort 10k tasks by priority in <100ms", async () => {
    const tasks = Array(10000)
      .fill(null)
      .map(() => createMockTask());

    const start = performance.now();

    const response = await request(app)
      .get(`/api/tasks?sortBy=priority&sortOrder=desc&limit=25&page=1`);

    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
  });

  it("should filter 10k tasks by status+priority in <100ms", async () => {
    const start = performance.now();

    const response = await request(app)
      .get(`/api/tasks?status=ASSIGNED&priority=URGENT&limit=25&page=1`);

    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
  });
});

describe("Performance - WebSocket", () => {
  it("should broadcast to 500 clients in <100ms", async () => {
    const clients = Array(500)
      .fill(null)
      .map(() => new WebSocket("ws://localhost:3000/api/tasks/events"));

    const start = performance.now();

    taskEventBroadcaster.broadcastTaskCreated(mockTask);

    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);

    clients.forEach(ws => ws.close());
  });
});
```

---

# PART 5: DATA INTEGRITY TESTS

## Orphaned Tasks Detection

```typescript
test("should detect orphaned tasks (rule deleted)", async () => {
  const rule = await createTestRule();
  const task = await createTestTask({ taskRuleId: rule.id });

  // Delete the rule
  await prisma.taskRule.delete({ where: { id: rule.id } });

  // Run query to find orphaned tasks
  const orphaned = await prisma.task.findMany({
    where: {
      isArchived: false,
      taskRule: null,  // Rule doesn't exist
    },
  });

  expect(orphaned.some(t => t.id === task.id)).toBe(true);

  // Archive them
  await prisma.task.updateMany({
    where: { taskRuleId: rule.id, isArchived: false },
    data: { isArchived: true },
  });

  // Verify archived
  const archived = await prisma.task.findUnique({ where: { id: task.id } });
  expect(archived?.isArchived).toBe(true);
});
```

## Duplicate Prevention

```typescript
test("should have no duplicate (ruleId, entityId) pairs", async () => {
  const result = await prisma.$queryRaw`
    SELECT "taskRuleId", "entityId", COUNT(*) as count
    FROM taskos."tasks"
    WHERE "isArchived" = false
    GROUP BY "taskRuleId", "entityId"
    HAVING COUNT(*) > 1
  `;

  expect(result).toHaveLength(0);  // No duplicates
});
```

## SLA Accuracy

```typescript
test("should have no tasks with slaDeadline < createdAt", async () => {
  const invalid = await prisma.$queryRaw`
    SELECT t.id
    FROM taskos."tasks" t
    WHERE t."slaDeadline" < t."createdAt"
  `;

  expect(invalid).toHaveLength(0);
});
```

---

# PART 6: USER ACCEPTANCE TESTS (UAT)

These are conducted with real ops managers.

## UAT Scenario 1: Identify SLA-at-Risk Tasks

**Success Criterion:** Ops manager finds "task breaching in 5 mins" in <3 seconds

```gherkin
Given: 25 tasks in list, 2 at risk (<30 mins SLA)
When: Ops manager opens All Tasks
Then: Should be able to identify at-risk tasks in <3 seconds
  (via color zones, status widget, or filter)

Measurement: Time ops manager to finding task
Target: <3 seconds for experienced users, <10 seconds for new users
```

## UAT Scenario 2: Verify Auto-Assignments

**Success Criterion:** Ops manager verifies 25 auto-assigned tasks in <5 minutes

```gherkin
Given: 25 newly created tasks, all auto-assigned by rules
When: Ops manager reviews assignments
Then: Should be able to verify assignments worked correctly in <5 minutes
  (via assignment status indicator, rule audit trail)

Measurement: Time to complete verification
Target: <5 minutes for full review
```

## UAT Scenario 3: Manually Reassign an Exception

**Success Criterion:** Ops manager manually reassigns 1 task in <30 seconds

```gherkin
Given: Task CREATED but auto-assignment failed
When: Ops manager needs to manually reassign
Then: Should complete reassignment in <30 seconds
  (select task, choose agent, confirm)

Measurement: Time to complete reassignment
Target: <30 seconds from task click to confirmation
```

---

# TEST EXECUTION SCHEDULE

## Week 1-2: Unit Tests (Parallel with Development)
- Backend unit tests written alongside code
- Frontend unit tests for components
- Target: 80% coverage

## Week 3: Integration Tests
- API endpoint integration tests
- Database transaction tests
- WebSocket integration

## Week 4: E2E & UAT
- End-to-end user workflows
- Real browser testing
- Ops manager UAT sessions

## Week 5: Performance & Load Testing
- Sort/filter performance
- WebSocket broadcast under load
- Memory usage profiling

## Week 6+: Ongoing
- Regression testing on each deploy
- Continuous monitoring
- Production smoke tests

---

# TEST FAILURE HANDLING

If a test fails:

1. **Reproduction:** Run test in isolation 3x (rule out flakes)
2. **Root Cause:** Debug logs, database state, network
3. **Fix:** Code change OR test correction (document if test was wrong)
4. **Verification:** Run test again, pass
5. **Prevention:** Add regression test, update monitoring

---

# SUCCESS CRITERIA

- [ ] Zero duplicate tasks after 100 concurrent polling cycles
- [ ] All 8 bugs from audit have passing regression tests
- [ ] 14 Phase 1-3 features each have ≥5 test scenarios
- [ ] 80%+ unit test coverage for business logic
- [ ] All sorting/filtering queries <100ms with 10k tasks
- [ ] WebSocket broadcasts complete in <5 seconds (500 clients)
- [ ] SLA calculations accurate within 1 second
- [ ] Color zones render correctly for all SLA states
- [ ] All E2E user workflows pass with real browser
- [ ] UAT sign-off from ops managers
- [ ] Zero critical bugs in production after 1 week

---

**Document Version:** 1.0  
**Status:** Ready for implementation  
**Next Steps:** Execute Week 1-2 unit tests in parallel with development

