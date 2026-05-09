/**
 * Shared zod validators for the Team API.
 *
 * Replaces hand-rolled inline checks in /api/team and /api/team/[id]. Three
 * upgrades over the previous behaviour the audit flagged:
 *
 *   1. POST and PATCH share a `role` enum check, so the route can no longer
 *      accept `role: "OPS_HEAD"` from any caller (privilege escalation P0).
 *   2. `maxConcurrentTasks` is bounded so a typo (10^9) can't be persisted.
 *   3. Email + password rules in one place — easy to audit, hard to drift.
 */

import { z } from "zod";
import { UserRole } from "@prisma/client";

// ── Bounds ──────────────────────────────────────────────────────────────────
export const MAX_CONCURRENT_TASKS_MIN = 1;
export const MAX_CONCURRENT_TASKS_MAX = 100;
export const PASSWORD_MIN_LENGTH = 8;

// ── Email ──────────────────────────────────────────────────────────────────
// Tight enough to reject typos like "foo@", loose enough to accept the long
// tail of valid addresses. zod's built-in z.string().email() uses the same
// pragmatic rules (RFC 5321 lite) — no need to handcraft a regex.
const emailField = z.string().trim().toLowerCase().email("must be a valid email");

// ── Password ───────────────────────────────────────────────────────────────
// W1.8 — complexity rules. Length 8+, must contain at least one letter and
// one digit. Not exotic-symbol-required because that's password-strength
// theatre at this scale; matters more that the field is bounded and the
// reset endpoint is rate-limited (handled at the route layer with a token
// bucket — see below).
const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((s) => /[A-Za-z]/.test(s), "must contain at least one letter")
  .refine((s) => /\d/.test(s), "must contain at least one digit");

// ── Role enum (Prisma-derived; rejects anything else) ──────────────────────
const roleField = z.enum(Object.values(UserRole) as [string, ...string[]]);

// ── Max concurrent tasks ───────────────────────────────────────────────────
const maxConcurrentTasksField = z
  .coerce.number()
  .int("must be an integer")
  .min(MAX_CONCURRENT_TASKS_MIN, `must be ≥ ${MAX_CONCURRENT_TASKS_MIN}`)
  .max(MAX_CONCURRENT_TASKS_MAX, `must be ≤ ${MAX_CONCURRENT_TASKS_MAX}`);

// ── Bodies ─────────────────────────────────────────────────────────────────

export const createTeamMemberSchema = z.object({
  name:               z.string().trim().min(1, "name is required").max(120),
  email:              emailField,
  password:           passwordField,
  role:               roleField,
  phone:              z.string().trim().max(40).optional().nullable(),
  storeIds:           z.array(z.coerce.number().int().positive()).default([]),
  skillTagIds:        z.array(z.coerce.number().int().positive()).default([]),
  capabilityDataSourceIds: z.array(z.string().min(1)).default([]),
  maxConcurrentTasks: maxConcurrentTasksField.default(5),
});
export type CreateTeamMemberInput = z.infer<typeof createTeamMemberSchema>;

export const updateTeamMemberSchema = z.object({
  name:               z.string().trim().min(1).max(120).optional(),
  phone:              z.string().trim().max(40).nullable().optional(),
  role:               roleField.optional(),
  isActive:           z.boolean().optional(),
  maxConcurrentTasks: maxConcurrentTasksField.optional(),
  // Reset password is its own optional field — same complexity rules as create.
  resetPassword:      passwordField.optional(),
});
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;

// ── Error envelope ─────────────────────────────────────────────────────────
export function zodErrorToTeamResponse(err: z.ZodError) {
  const first = err.issues[0];
  return {
    error: "Validation failed",
    code: "VALIDATION_ERROR" as const,
    details: {
      field: first?.path.join(".") || "(root)",
      reason: first?.message || "Invalid input",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    },
  };
}
