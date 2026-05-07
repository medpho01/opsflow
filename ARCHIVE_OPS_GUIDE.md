# Archive System - Operations Guide

For operations agents managing TaskOS

---

## 🎯 What Changed?

**Before:** Dashboard showed all 320 tasks (including old April orders stuck in escalation)

**After:** Dashboard shows only 45 active tasks (current orders) → **Much clearer focus!**

---

## 📊 Dashboard View

### Task Counts Widget (Updated)

```
┌─────────────────┬──────────────┬────────────┐
│  Active Tasks   │   Archived   │ Completed  │
│       45        │      275     │     45     │
│ Focus on these  │ For audit    │    Done    │
└─────────────────┴──────────────┴────────────┘
```

**What This Means:**
- **Active Tasks (45)** = Tasks on current orders you need to work on TODAY
- **Archived Tasks (275)** = Old stuck tasks from April (for record keeping)
- **Completed (45)** = Tasks you've finished

---

## 📋 How It Works

### Automatic Archiving (Happens nightly at 2 AM)

Tasks are **automatically moved to archive** if:
- ✅ Appointment date is **more than 10 days old**
- ✅ Task is NOT already completed or cancelled

**Example:**
- Order appointment: April 1, 2026
- Today: April 30, 2026
- Days since appointment: 29 days
- Status: **ARCHIVED** ✓ (auto-moved out of active view)

---

## 🔄 Can I Get Old Tasks Back?

**YES!** If you need to reactivate an archived task:

### Option 1: Click "Restore" Button

If your task has an archive indicator, click the **Restore** button to bring it back to active view.

### Option 2: Contact System Admin

Ask your admin to restore the task:
```
POST /api/tasks/123/unarchive
```

**Important:** The task is NEVER deleted. It's always in the database for audit purposes.

---

## 📈 Archive Statistics

You can see archive stats anytime:

### Dashboard Widget
Shows live counts of:
- Active tasks (your focus)
- Archived tasks (for reference)
- Completed tasks (done)

### Archive View Page
Shows all archived tasks with:
- Order ID
- Patient name
- Original creation date
- Reason archived
- Quick restore button

---

## ❓ FAQ

**Q: Will I lose information about old orders?**
A: No! All information stays in the database. You can view archived tasks anytime if needed. Nothing is deleted.

**Q: What if a patient calls about an old appointment?**
A: You can quickly search the archive to see what happened:
1. Go to Archive View
2. Search by patient name or order ID
3. See complete history

**Q: Can I restore an archived task?**
A: Yes! Click "Restore" button on the archived task, and it comes back to active view.

**Q: Why archive old tasks?**
A: Keeps the dashboard focused on current work. 275 old stuck tasks were creating noise and distraction. Now you see only the 45 active ones you can actually work on.

**Q: Can I change when archiving happens?**
A: Yes. Currently set for 10 days old. Can be adjusted to:
- 3 days (very aggressive)
- 7 days (standard)
- 10 days (current - recommended)
- 14 days (conservative)
- 30 days (very conservative)

Contact your admin to adjust if needed.

---

## 🚀 How to Use

### Daily Workflow

```
Morning ↓
  1. Open TaskOS dashboard
  2. See "Active Tasks: 45" ✅ (Clear, focused list)
  3. Work through today's tasks
  4. Complete/cancel as appropriate
  ↓
Evening ↓
  1. Archive job runs automatically (2 AM)
  2. Old April tasks move to archive
  3. Dashboard stays clean ✅
```

### If You Need to Restore a Task

```
1. Click "View Archive" link on dashboard
2. Find the task in archive list
3. Click "Restore" button
4. Task appears in active list again
```

### If You Need to Search Old Records

```
1. Click "View Archive" link
2. Search by:
   - Patient name
   - Order ID
   - Date range
3. View complete task history
```

---

## 📊 Before & After Comparison

### Before Archive System
```
Tasks to track:   320
├── Active: 45 (2% of list)
├── April stuck: 275 (85% of list) ← TOO MUCH NOISE
└── Result: Agents distracted, hard to focus
```

### After Archive System
```
Active View:      45 (100% relevant)
├── Today's work: 40
├── Tomorrow:     5
└── Result: Clear focus, better productivity ✅

Archive View:     275 (for reference if needed)
└── Complete history available
```

---

## 🔍 Transparency

Everything is transparent. You can:
- ✅ See what tasks are active
- ✅ See what tasks are archived
- ✅ See why a task was archived (10+ days old)
- ✅ Restore any archived task instantly
- ✅ Search/view full history anytime

Nothing is hidden. Nothing is deleted. All data stays for audit.

---

## 💡 Tips

**Tip 1:** Check archive stats occasionally to see task lifecycle
- High archived count = System is managing old tasks well
- Low archived count = Most orders moving through actively

**Tip 2:** Use archive search to understand past patterns
- Stuck orders = Archives full of them
- Smooth workflow = Archive fills slowly

**Tip 3:** Restore archived tasks if you need to revisit
- Patient calls about old order? Restore to see context
- Escalation issue? View full history in archive

---

## 📞 Questions?

**Issue:** Task I need isn't showing
→ Check archive view (it might be archived but needed)

**Issue:** Too many active tasks
→ Not an archive problem - indicates high order volume

**Issue:** Want to change archiving rules
→ Contact system admin to adjust 10-day threshold

**Issue:** Can't restore a task
→ Ask system admin for help

---

## Key Takeaway

**The archive system keeps your dashboard focused on TODAY'S WORK while preserving complete history.**

- Fewer distractions ✅
- Better focus ✅
- Complete audit trail ✅
- Full transparency ✅

No data lost. No functionality removed. Just a cleaner view of what matters NOW.
