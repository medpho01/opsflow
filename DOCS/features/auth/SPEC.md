# Authentication & Sessions — Feature Spec

## Purpose
Identify the user, enforce role-based access, and secure all API + UI surfaces with short-lived sessions.

## Roles
- **OPS_HEAD** — full access; manages team, rules, sources; sees everything
- **STORE_ADMIN** — scoped to one or more stores; sees and acts on store-local data only
- **OPS_AGENT** — scoped to assigned tasks; cannot reassign or modify rules

## User stories
- As any user, I log in with email + password and stay logged in for 8 hours.
- As any user, I can change my password (which logs out all my other sessions).
- As any user, I can log out, which immediately invalidates my session.
- As an Ops Head, I can deactivate a user, which prevents them from logging in.

## Auth model
- Passwords hashed with bcrypt (cost 12; cost 10 in dev seed).
- Sessions are JWT-signed with `jose` (HS256, 8h TTL) AND backed by a `Session` row in DB so logout / password-change can revoke immediately.
- Cookie: `taskos_token`, httpOnly, SameSite=lax, Secure in prod, Path=/, Max-Age=28800.

## Edge cases
- Invalid / expired token → 401 + cookie cleared
- Token decoded but no matching DB session → 401 (revocation case)
- Inactive user logs in → 403
- Login with wrong password → generic "Invalid credentials" (no enumeration)
