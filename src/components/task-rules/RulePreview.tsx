'use client';

/**
 * RulePreview - Real-time preview of rule trigger logic
 */

import React from 'react';

interface RulePreviewProps {
  formData: any;
  validStatuses: any[];
}

export default function RulePreview({ formData, validStatuses }: RulePreviewProps) {
  const getStatusLabels = () => {
    return formData.triggerCondition.statusIn
      .map((status: string) => {
        const found = validStatuses.find(s => s.value === status);
        return found?.label || status;
      })
      .join(', ');
  };

  const buildPreviewText = () => {
    const parts: string[] = [];

    if (formData.triggerCondition.statusIn?.length > 0) {
      parts.push(`Order status IN [${getStatusLabels()}]`);
    }

    if (formData.triggerCondition.minutesSinceCreated) {
      parts.push(`AND created > ${formData.triggerCondition.minutesSinceCreated} minutes ago`);
    }

    if (formData.triggerCondition.minutesSinceStatusUpdated) {
      parts.push(`AND in current status > ${formData.triggerCondition.minutesSinceStatusUpdated} minutes`);
    }

    if (formData.triggerCondition.minutesBeforeAppointment) {
      parts.push(`AND appointment within ${formData.triggerCondition.minutesBeforeAppointment} minutes`);
    }

    if (formData.triggerCondition.minutesAfterAppointment) {
      parts.push(`AND appointment passed >= ${formData.triggerCondition.minutesAfterAppointment} minutes ago`);
    }

    if (formData.triggerCondition.metadataConditions?.length > 0) {
      formData.triggerCondition.metadataConditions.forEach((mc: any) => {
        if (mc.fieldPath) {
          parts.push(`AND metadata.${mc.fieldPath} ${mc.operator} ${mc.value || ''}`);
        }
      });
    }

    return parts.join('\n');
  };

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 sticky top-6">
      <h3 className="text-lg font-semibold mb-4">Trigger Preview</h3>

      <div className="space-y-4">
        {/* Rule Summary */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3">
          <div className="text-xs font-medium text-blue-900 mb-2">WHEN TRIGGERED:</div>
          {formData.triggerCondition.statusIn?.length > 0 ? (
            <div className="whitespace-pre-wrap text-xs text-blue-800 font-mono">
              {buildPreviewText()}
            </div>
          ) : (
            <div className="text-xs text-gray-500 italic">
              No conditions configured yet
            </div>
          )}
        </div>

        {/* Task Details */}
        <div className="border-t pt-4">
          <div className="text-xs font-medium text-gray-700 mb-2">TASK DETAILS:</div>
          <div className="space-y-1 text-xs">
            <div>
              <span className="text-gray-600">Type:</span>
              <span className="ml-2 font-mono">{formData.taskTypeId || 'Not selected'}</span>
            </div>
            <div>
              <span className="text-gray-600">Title:</span>
              <span className="ml-2 font-mono text-gray-700">
                {formData.titleTemplate || 'No template'}
              </span>
            </div>
            <div>
              <span className="text-gray-600">SLA:</span>
              <span className="ml-2 font-mono">{formData.slaMinutes} minutes</span>
            </div>
            <div>
              <span className="text-gray-600">Priority:</span>
              <span className={`ml-2 font-mono px-2 py-1 rounded text-white ${
                formData.priority === 'URGENT' ? 'bg-red-500' :
                formData.priority === 'HIGH' ? 'bg-orange-500' :
                formData.priority === 'MEDIUM' ? 'bg-blue-500' :
                'bg-gray-500'
              }`}>
                {formData.priority}
              </span>
            </div>
            <div>
              <span className="text-gray-600">Status:</span>
              <span className={`ml-2 font-mono px-2 py-1 rounded ${
                formData.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
              }`}>
                {formData.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        </div>

        {/* Warnings */}
        {formData.triggerCondition.statusIn?.length === 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
            <div className="text-xs text-yellow-700">
              ⚠️ Please select at least one order status
            </div>
          </div>
        )}

        {!formData.name?.trim() && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-3">
            <div className="text-xs text-yellow-700">
              ⚠️ Please enter a rule name
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
