'use client';

/**
 * MetadataConditionBlock - Single metadata condition in the builder
 */

import React from 'react';

interface MetadataConditionBlockProps {
  condition: any;
  metadataFields: any[];
  onUpdate: (updates: any) => void;
  onRemove: () => void;
}

export default function MetadataConditionBlock({
  condition,
  metadataFields,
  onUpdate,
  onRemove,
}: MetadataConditionBlockProps) {
  const selectedField = metadataFields.find(f => f.fieldPath === condition.fieldPath);
  const availableOperators = selectedField?.operators || [
    'exists', 'not_exists', 'equals', 'not_equals',
    'contains', 'starts_with', 'ends_with',
    '>', '>=', '<', '<='
  ];

  return (
    <div className="flex gap-2 items-end p-3 bg-gray-50 border border-gray-200 rounded">
      {/* Field Path */}
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Field
        </label>
        <select
          value={condition.fieldPath}
          onChange={(e) => onUpdate({ fieldPath: e.target.value })}
          className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select field</option>
          {metadataFields.map(field => (
            <option key={field.fieldPath} value={field.fieldPath}>
              {field.fieldPath}
            </option>
          ))}
        </select>
      </div>

      {/* Operator */}
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Operator
        </label>
        <select
          value={condition.operator}
          onChange={(e) => onUpdate({ operator: e.target.value })}
          className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {availableOperators.map(op => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </div>

      {/* Value */}
      {!['exists', 'not_exists'].includes(condition.operator) && (
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Value
          </label>
          <input
            type="text"
            value={condition.value || ''}
            onChange={(e) => onUpdate({ value: e.target.value })}
            className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Value"
          />
        </div>
      )}

      {/* Offset Minutes (for timestamp fields) */}
      {selectedField?.type === 'timestamp' && ['>',  '>=', '<', '<='].includes(condition.operator) && (
        <div className="w-32">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Offset (min)
          </label>
          <input
            type="number"
            value={condition.offsetMinutes || ''}
            onChange={(e) =>
              onUpdate({
                offsetMinutes: e.target.value ? parseInt(e.target.value, 10) : undefined,
              })
            }
            className="w-full px-2 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="minutes"
          />
        </div>
      )}

      {/* Remove Button */}
      <button
        type="button"
        onClick={onRemove}
        className="px-3 py-2 text-red-600 hover:text-red-700 font-medium text-sm"
      >
        ✕
      </button>
    </div>
  );
}
