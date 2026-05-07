'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

interface Rule {
  id: string;
  name: string;
  orderType: string;
  priority: string;
  isActive: boolean;
  totalTasksCreated: number;
  tasksLast24h: number;
}

export default function RulesListPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRules();
  }, []);

  const fetchRules = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/task-rules');
      if (!res.ok) throw new Error('Failed to fetch rules');
      const data = await res.json();
      setRules(data.rules || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  };

  const priorityColor = (priority: string) => {
    switch (priority) {
      case 'URGENT':
        return 'bg-red-100 text-red-800';
      case 'HIGH':
        return 'bg-orange-100 text-orange-800';
      case 'MEDIUM':
        return 'bg-blue-100 text-blue-800';
      case 'LOW':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading rules...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-900 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-white">Task Rules</h1>
          <Link
            href="/head/rules/new"
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            + New Rule
          </Link>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-900/20 border border-red-800 rounded text-red-400">
            {error}
          </div>
        )}

        <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-700 border-b border-slate-600">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Name</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Order Type</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Priority</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Status</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Tasks (24h)</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Total</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-200">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-slate-700 hover:bg-slate-700/50">
                  <td className="px-6 py-3 text-white font-medium">{rule.name}</td>
                  <td className="px-6 py-3 text-sm text-gray-400">{rule.orderType}</td>
                  <td className="px-6 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${priorityColor(rule.priority)}`}>
                      {rule.priority}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${
                      rule.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {rule.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-400">{rule.tasksLast24h}</td>
                  <td className="px-6 py-3 text-sm text-gray-400">{rule.totalTasksCreated}</td>
                  <td className="px-6 py-3 text-sm">
                    <Link
                      href={`/head/rules/${rule.id}`}
                      className="text-blue-600 hover:text-blue-700 font-medium"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rules.length === 0 && !error && (
          <div className="text-center py-12">
            <p className="text-gray-400 mb-4">No rules yet</p>
            <Link
              href="/head/rules/new"
              className="text-blue-600 hover:text-blue-700 font-medium"
            >
              Create your first rule
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
