# Authentication — Implementation

## Files
- **Login**: `src/app/api/auth/login/route.ts`
- **Logout**: `src/app/api/auth/logout/route.ts`
- **Change password**: `src/app/api/auth/change-password/route.ts`
- **Current user**: `src/app/api/auth/me/route.ts` (note: dead-code audit flags as unused)
- **JWT**: `src/lib/auth/jwt.ts`
- **Session lookup**: `src/lib/auth/session.ts`
- **Password hashing**: `src/lib/auth/password.ts`
- **Login page**: `src/app/login/page.tsx`

## Models (prisma/schema.prisma)
- `User` — email, name, role (UserRole enum), passwordHash, isActive
- `Session` — userId, token, expiresAt; FK CASCADE on User delete

## Flow — login
1. POST `/api/auth/login` { email, password }
2. Find User; bcrypt.compare against passwordHash
3. Sign JWT with `jose` (8h)
4. Insert Session row with token + expiry
5. Set `taskos_token` cookie
6. Respond with `{ user: { id, name, email, role }, redirectPath }`

## Flow — request authorization
1. Middleware-equivalent helper `getSessionFromRequest` reads cookie
2. Verify JWT signature + expiry
3. Look up Session row; if missing → revoked → 401
4. Return user record to handler

## Known gaps (see SECURITY_AUDIT)
- P0: `JWT_SECRET` falls back to a hardcoded literal — must throw on missing env in prod
- P2: No login rate-limiting; existing `rateLimit` helper in `lib/observability/rate-limit.ts` is unused on login
