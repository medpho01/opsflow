/**
 * VIP badge.
 *
 * Presentation only. VIP is decided by src/lib/priority/vipResolver.ts and
 * stored on the snapshot; this component never infers it.
 *
 * `notEvaluated` renders the third state the classifier distinguishes: no VIP
 * provider could be evaluated for this order, which is NOT the same as a
 * confident "not VIP" and must not look like one.
 */
interface VipBadgeProps {
  vip: boolean;
  notEvaluated?: boolean;
}

export default function VipBadge({ vip, notEvaluated = false }: VipBadgeProps) {
  if (vip) {
    return (
      <span className="inline-flex items-center rounded border text-[10px] px-1.5 py-0.5 font-medium bg-amber-500/15 text-amber-400 border-amber-500/30">
        VIP
      </span>
    );
  }
  if (notEvaluated) {
    return (
      <span
        title="No VIP signal could be measured for this order"
        className="inline-flex items-center rounded border text-[10px] px-1.5 py-0.5 font-medium bg-zinc-700/20 text-zinc-500 border-zinc-700/40"
      >
        not evaluated
      </span>
    );
  }
  return <span className="text-[10px] text-zinc-600">—</span>;
}
