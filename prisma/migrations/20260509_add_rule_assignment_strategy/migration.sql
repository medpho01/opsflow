-- W4.2 — Add `assignmentStrategy` column to task_rules.
--
-- The audit flagged that the rule editor showed an Assignment Strategy
-- dropdown with 5 options but only "least_loaded" was actually implemented.
-- The dropdown's choice was never persisted (no column existed) — the
-- strategy field lived on `task_rule_source_scopes`, which is dead.
--
-- This migration moves the strategy onto TaskRule so:
--   1. The UI selection is actually saved.
--   2. pickAssignee() can branch on it per-rule.
--
-- Default "default" preserves the existing behaviour (least-loaded with a
-- round-robin tiebreaker).

ALTER TABLE taskos.task_rules
  ADD COLUMN IF NOT EXISTS "assignmentStrategy" TEXT NOT NULL DEFAULT 'default';

-- Document the allowed values via a check constraint. We don't use a
-- Postgres enum because adding new strategies later would require a second
-- migration to extend it.
ALTER TABLE taskos.task_rules
  ADD CONSTRAINT task_rules_assignment_strategy_check
  CHECK ("assignmentStrategy" IN (
    'default',
    'round_robin',
    'store_affinity',
    'skill_based',
    'least_loaded'
  ));
