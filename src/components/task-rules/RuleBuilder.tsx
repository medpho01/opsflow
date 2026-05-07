'use client';

/**
 * RuleBuilder - Main component for creating and editing task rules
 * Super Admin interface for rule configuration with visual trigger builder
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import RuleForm from './RuleForm';

interface RuleBuilderProps {
  ruleId?: string;
  onSuccess?: () => void;
}

export default function RuleBuilder({ ruleId, onSuccess }: RuleBuilderProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rule, setRule] = useState<any>(null);

  useEffect(() => {
    if (ruleId) {
      fetchRule();
    }
  }, [ruleId]);

  const fetchRule = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/task-rules/${ruleId}`);
      if (!res.ok) throw new Error('Failed to fetch rule');
      const data = await res.json();
      setRule(data.rule);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rule');
    } finally {
      setLoading(false);
    }
  };

  const handleSuccess = () => {
    if (onSuccess) {
      onSuccess();
    } else {
      router.push('/admin/rules');
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold">
            {ruleId ? 'Edit Rule' : 'Create New Rule'}
          </h1>
          <button
            onClick={() => router.back()}
            className="px-4 py-2 text-gray-600 hover:text-gray-900"
          >
            ← Back
          </button>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded text-red-700">
            {error}
          </div>
        )}

        <RuleForm initialRule={rule} onSuccess={handleSuccess} />
      </div>
    </div>
  );
}
