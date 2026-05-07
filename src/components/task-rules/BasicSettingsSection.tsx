'use client';

/**
 * BasicSettingsSection - Rule name, order type, task type, SLA, priority
 */

import React, { useState, useEffect } from 'react';

interface BasicSettingsSectionProps {
  formData: any;
  updateField: (field: string, value: any) => void;
}

export default function BasicSettingsSection({
  formData,
  updateField,
}: BasicSettingsSectionProps) {
  const [taskTypes, setTaskTypes] = useState<any[]>([]);

  const AVAILABLE_VARS = "{{patientName}}, {{orderId}}, {{storeName}}, {{labName}}, {{appointmentTime}}";

  useEffect(() => {
    fetchTaskTypes();
  }, []);

  const fetchTaskTypes = async () => {
    try {
      const res = await fetch('/api/task-types');
      if (res.ok) {
        const data = await res.json();
        setTaskTypes(data.taskTypes || []);
      }
    } catch (err) {
      console.error('Failed to fetch task types:', err);
    }
  };

  const orderTypes = ['HOME_SAMPLE', 'CENTER_VISIT', 'INJECTION'];
  const priorities = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];

  return (
    <div className="bg-slate-800 p-6 rounded-lg border border-slate-700">
      <h3 className="text-lg font-semibold mb-4 text-white">Basic Settings</h3>

      <div className="space-y-4">
        {/* Rule Name */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Rule Name
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g., HSC-R1: 30-Min Booking Confirm"
            required
          />
        </div>

        {/* Order Type */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Order Type
          </label>
          <select
            value={formData.orderType}
            onChange={(e) => updateField('orderType', e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          >
            <option value="">Select order type</option>
            {orderTypes.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>

        {/* Task Type */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Task Type
          </label>
          <select
            value={formData.taskTypeId}
            onChange={(e) => updateField('taskTypeId', e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          >
            <option value="">Select task type</option>
            {taskTypes.map(type => (
              <option key={type.id} value={type.id}>{type.label}</option>
            ))}
          </select>
        </div>

        {/* Title Template */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Title Template
          </label>
          <textarea
            value={formData.titleTemplate}
            onChange={(e) => updateField('titleTemplate', e.target.value)}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g., Confirm {{patientName}} appointment"
            rows={2}
            required
          />
          <p className="text-xs text-gray-400 mt-1">
            Available variables: {AVAILABLE_VARS}
          </p>
        </div>

        {/* SLA Minutes */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            SLA Minutes
          </label>
          <input
            type="number"
            value={formData.slaMinutes}
            onChange={(e) => updateField('slaMinutes', parseInt(e.target.value, 10))}
            className="w-full px-3 py-2 border border-slate-600 bg-slate-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            min="1"
            required
          />
        </div>

        {/* Priority */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Priority
          </label>
          <div className="grid grid-cols-4 gap-2">
            {priorities.map(priority => (
              <label key={priority} className="flex items-center cursor-pointer">
                <input
                  type="radio"
                  name="priority"
                  value={priority}
                  checked={formData.priority === priority}
                  onChange={(e) => updateField('priority', e.target.value)}
                  className="mr-2"
                />
                <span className="text-sm text-gray-300">{priority}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Active Toggle */}
        <div className="flex items-center">
          <input
            type="checkbox"
            id="isActive"
            checked={formData.isActive}
            onChange={(e) => updateField('isActive', e.target.checked)}
            className="mr-3"
          />
          <label htmlFor="isActive" className="text-sm font-medium text-gray-300 cursor-pointer">
            Active
          </label>
        </div>
      </div>
    </div>
  );
}
