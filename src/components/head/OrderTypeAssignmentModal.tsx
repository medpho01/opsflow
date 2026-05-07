"use client";

import { useState, useEffect } from "react";
import { OrderTypeOption } from "@/types";

interface OrderTypeAssignmentModalProps {
  memberId: number;
  memberName: string;
  currentOrderTypes: string[];
  onClose: () => void;
  onSaved: () => void;
}

export function OrderTypeAssignmentModal({
  memberId,
  memberName,
  currentOrderTypes,
  onClose,
  onSaved,
}: OrderTypeAssignmentModalProps) {
  const [orderTypes, setOrderTypes] = useState<OrderTypeOption[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    new Set(currentOrderTypes)
  );
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch all available order types
  useEffect(() => {
    async function loadOrderTypes() {
      try {
        setLoading(true);
        const res = await fetch("/api/order-types");
        if (!res.ok) throw new Error("Failed to load order types");
        const data = await res.json();
        setOrderTypes(data.orderTypes || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    loadOrderTypes();
  }, []);

  const handleToggle = (orderType: string) => {
    const newSelected = new Set(selectedTypes);
    if (newSelected.has(orderType)) {
      newSelected.delete(orderType);
    } else {
      newSelected.add(orderType);
    }
    setSelectedTypes(newSelected);
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setError(null);

      // Determine additions and removals
      const toAdd = Array.from(selectedTypes).filter(
        (type) => !currentOrderTypes.includes(type)
      );
      const toRemove = currentOrderTypes.filter(
        (type) => !selectedTypes.has(type)
      );

      // Add new assignments
      for (const orderType of toAdd) {
        const res = await fetch(
          `/api/team/${memberId}/order-types`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderType }),
          }
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `Failed to assign ${orderType}`);
        }
      }

      // Remove old assignments
      for (const orderType of toRemove) {
        const res = await fetch(
          `/api/team/${memberId}/order-types/${orderType}`,
          {
            method: "DELETE",
          }
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `Failed to remove ${orderType}`);
        }
      }

      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full mx-4 max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Assign Order Types</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4">
          <p className="text-sm text-gray-600 mb-4">
            Manage which order types {memberName} can handle.
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : (
            <div className="space-y-2">
              {orderTypes.map((orderType) => (
                <label
                  key={orderType.name}
                  className="flex items-center p-3 border rounded hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedTypes.has(orderType.name)}
                    onChange={() => handleToggle(orderType.name)}
                    className="w-4 h-4 text-blue-600 rounded"
                  />
                  <div className="ml-3 flex-1">
                    <div className="font-medium text-sm">{orderType.label}</div>
                    <div className="text-xs text-gray-500">
                      {orderType.description}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t px-6 py-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={isSaving}
            className="px-4 py-2 text-gray-700 border rounded hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
