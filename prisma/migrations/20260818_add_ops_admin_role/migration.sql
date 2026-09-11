-- Add an OPS_ADMIN role. It carries the same authorization as OPS_HEAD (the
-- session layer coerces OPS_ADMIN → OPS_HEAD for all permission checks); the
-- distinct value exists so such users can be labelled "Ops Admin".
-- ALTER TYPE ... ADD VALUE is idempotent-guarded and cannot run in a txn block.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OPS_ADMIN';
