'use client';

/**
 * TimeConditionFields - Time-based trigger conditions
 */

import React from 'react';

interface TimeConditionFieldsProps {
  triggerCondition: any;
  updateTriggerCondition: (updates: any) => void;
}

export default function TimeConditionFields({
  triggerCondition,
  updateTriggerCondition,
}: TimeConditionFieldsProps) {
  return (
    <div className="border-t pt-4 space-y-4">
      <label className="block text-sm font-medium text-gray-700">
        Time-Based Conditions
      </label>

      <div className="grid grid-cols-2 gap-4">
        {/* Minutes Since Created */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Minutes Since Created
          </label>
          <input
            type="number"
            value={triggerCondition.minutesSinceCreated || ''}
            onChange={(e) =>
              updateTriggerCondition({
                minutesSinceCreated: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Leave blank to skip"
            min="0"
          />
        </div>

        {/* Minutes Since Status Updated */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Minutes in Current Status
          </label>
          <input
            type="number"
            value={triggerCondition.minutesSinceStatusUpdated || ''}
            onChange={(e) =>
              updateTriggerCondition({
                minutesSinceStatusUpdated: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Leave blank to skip"
            min="0"
          />
        </div>

        {/* Minutes Before Appointment */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Minutes Before Appointment
          </label>
          <input
            type="number"
            value={triggerCondition.minutesBeforeAppointment || ''}
            onChange={(e) =>
              updateTriggerCondition({
                minutesBeforeAppointment: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Leave blank to skip"
            min="0"
          />
        </div>

        {/* Minutes After Appointment */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Minutes After Appointment
          </label>
          <input
            type="number"
            value={triggerCondition.minutesAfterAppointment || ''}
            onChange={(e) =>
              updateTriggerCondition({
                minutesAfterAppointment: e.target.value
                  ? parseInt(e.target.value, 10)
                  : undefined,
              })
            }
            className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Leave blank to skip"
            min="0"
          />
        </div>
      </div>
    </div>
  );
}
