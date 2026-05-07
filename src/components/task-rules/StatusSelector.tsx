'use client';

/**
 * StatusSelector - Multi-select for order statuses with descriptions
 */

import React from 'react';

interface StatusSelectorProps {
  selectedStatuses: string[];
  onStatusesChange: (statuses: string[]) => void;
  validStatuses: any[];
}

export default function StatusSelector({
  selectedStatuses,
  onStatusesChange,
  validStatuses,
}: StatusSelectorProps) {
  const handleToggle = (status: string) => {
    if (selectedStatuses.includes(status)) {
      onStatusesChange(selectedStatuses.filter(s => s !== status));
    } else {
      onStatusesChange([...selectedStatuses, status]);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-3">
        Order Status
      </label>
      <div className="grid grid-cols-1 gap-2">
        {validStatuses.map(status => (
          <label
            key={status.value}
            className="flex items-start p-3 border border-gray-200 rounded cursor-pointer hover:bg-gray-50"
          >
            <input
              type="checkbox"
              checked={selectedStatuses.includes(status.value)}
              onChange={() => handleToggle(status.value)}
              className="mt-1 mr-3"
            />
            <div className="flex-1">
              <div className="font-medium text-sm text-gray-900">
                {status.label}
              </div>
              <div className="text-xs text-gray-500">
                {status.description}
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
