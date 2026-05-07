"use client";

interface OrderType {
  orderType: string;
  assignedAt?: Date;
}

interface OrderTypeDisplayProps {
  orderTypes: OrderType[];
  onEditClick?: () => void;
  editable?: boolean;
}

const orderTypeColors: Record<string, { bg: string; text: string }> = {
  HOME_SAMPLE: { bg: "bg-blue-100", text: "text-blue-700" },
  CENTER_VISIT: { bg: "bg-green-100", text: "text-green-700" },
  INJECTION: { bg: "bg-purple-100", text: "text-purple-700" },
};

export function OrderTypeDisplay({
  orderTypes,
  onEditClick,
  editable = false,
}: OrderTypeDisplayProps) {
  const formatOrderTypeName = (orderType: string): string => {
    return orderType
      .split("_")
      .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
      .join(" ");
  };

  if (!orderTypes || orderTypes.length === 0) {
    return (
      <div className="text-xs text-gray-500 italic">
        {editable ? "No order types assigned" : "—"}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {orderTypes.map((ot) => {
        const colors = orderTypeColors[ot.orderType] || {
          bg: "bg-gray-100",
          text: "text-gray-700",
        };
        return (
          <span
            key={ot.orderType}
            className={`inline-block px-2 py-1 rounded text-xs font-medium ${colors.bg} ${colors.text}`}
            title={
              ot.assignedAt
                ? `Assigned: ${new Date(ot.assignedAt).toLocaleDateString()}`
                : undefined
            }
          >
            {formatOrderTypeName(ot.orderType)}
          </span>
        );
      })}
      {editable && onEditClick && (
        <button
          onClick={onEditClick}
          className="text-xs px-2 py-1 rounded border border-dashed border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-700"
        >
          + Edit
        </button>
      )}
    </div>
  );
}
