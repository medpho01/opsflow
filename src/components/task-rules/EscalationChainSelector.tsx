'use client';

/**
 * EscalationChainSelector - Select escalation chain for rule
 */

import React, { useState, useEffect } from 'react';

interface EscalationChainSelectorProps {
  selectedChainId: number | null;
  onChainChange: (chainId: number | null) => void;
}

export default function EscalationChainSelector({
  selectedChainId,
  onChainChange,
}: EscalationChainSelectorProps) {
  const [chains, setChains] = useState<any[]>([]);

  useEffect(() => {
    fetchChains();
  }, []);

  const fetchChains = async () => {
    try {
      const res = await fetch('/api/escalation-chains');
      if (res.ok) {
        const data = await res.json();
        setChains(data.chains || []);
      }
    } catch (err) {
      console.error('Failed to fetch escalation chains:', err);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Escalation Chain (for SLA breach)
      </label>
      <select
        value={selectedChainId || ''}
        onChange={(e) =>
          onChainChange(e.target.value ? parseInt(e.target.value, 10) : null)
        }
        className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">None</option>
        {chains.map(chain => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </select>
    </div>
  );
}
