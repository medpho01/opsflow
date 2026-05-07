'use client';

/**
 * TriggerConditionBuilder - Complex component for building trigger conditions
 */

import React, { useState } from 'react';
import StatusSelector from './StatusSelector';
import TimeConditionFields from './TimeConditionFields';
import MetadataConditionBlock from './MetadataConditionBlock';

interface TriggerConditionBuilderProps {
  triggerCondition: any;
  updateTriggerCondition: (updates: any) => void;
  validStatuses: any[];
  metadataFields: any[];
}

export default function TriggerConditionBuilder({
  triggerCondition,
  updateTriggerCondition,
  validStatuses,
  metadataFields,
}: TriggerConditionBuilderProps) {
  const [showMetadata, setShowMetadata] = useState(false);

  const handleAddMetadataCondition = () => {
    const newCondition = {
      fieldPath: '',
      operator: 'exists',
      value: undefined,
    };
    updateTriggerCondition({
      metadataConditions: [...(triggerCondition.metadataConditions || []), newCondition],
    });
  };

  const handleRemoveMetadataCondition = (index: number) => {
    const updated = triggerCondition.metadataConditions.filter(
      (_: any, i: number) => i !== index
    );
    updateTriggerCondition({ metadataConditions: updated });
  };

  const handleUpdateMetadataCondition = (index: number, updates: any) => {
    const updated = [...(triggerCondition.metadataConditions || [])];
    updated[index] = { ...updated[index], ...updates };
    updateTriggerCondition({ metadataConditions: updated });
  };

  return (
    <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
      <h3 className="text-lg font-semibold mb-4 text-white">Trigger Conditions</h3>

      <div className="space-y-6">
        {/* Status Selector */}
        <StatusSelector
          selectedStatuses={triggerCondition.statusIn || []}
          onStatusesChange={(statuses) =>
            updateTriggerCondition({ statusIn: statuses })
          }
          validStatuses={validStatuses}
        />

        {/* Time Conditions */}
        <TimeConditionFields
          triggerCondition={triggerCondition}
          updateTriggerCondition={updateTriggerCondition}
        />

        {/* Metadata Conditions Toggle */}
        <div className="border-t border-slate-700 pt-6">
          <button
            type="button"
            onClick={() => setShowMetadata(!showMetadata)}
            className="text-blue-400 hover:text-blue-300 text-sm font-medium"
          >
            {showMetadata ? '▼' : '▶'} Metadata Conditions (Advanced)
          </button>

          {showMetadata && (
            <div className="mt-4 space-y-3">
              {(triggerCondition.metadataConditions || []).map(
                (condition: any, index: number) => (
                  <MetadataConditionBlock
                    key={index}
                    condition={condition}
                    metadataFields={metadataFields}
                    onUpdate={(updates) =>
                      handleUpdateMetadataCondition(index, updates)
                    }
                    onRemove={() => handleRemoveMetadataCondition(index)}
                  />
                )
              )}

              <button
                type="button"
                onClick={handleAddMetadataCondition}
                className="w-full px-3 py-2 border border-dashed border-slate-600 rounded text-gray-400 hover:text-gray-300 hover:border-slate-500 text-sm"
              >
                + Add Metadata Condition
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
