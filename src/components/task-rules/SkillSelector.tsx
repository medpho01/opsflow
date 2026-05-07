'use client';

/**
 * SkillSelector - Multi-select for required skills
 */

import React, { useState, useEffect } from 'react';

interface SkillSelectorProps {
  selectedSkills: number[];
  onSkillsChange: (skills: number[]) => void;
}

export default function SkillSelector({
  selectedSkills,
  onSkillsChange,
}: SkillSelectorProps) {
  const [skills, setSkills] = useState<any[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetchSkills();
  }, []);

  const fetchSkills = async () => {
    try {
      const res = await fetch('/api/skill-tags');
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch (err) {
      console.error('Failed to fetch skills:', err);
    }
  };

  const filteredSkills = skills.filter(skill =>
    skill.label.toLowerCase().includes(search.toLowerCase())
  );

  const handleToggle = (skillId: number) => {
    if (selectedSkills.includes(skillId)) {
      onSkillsChange(selectedSkills.filter(id => id !== skillId));
    } else {
      onSkillsChange([...selectedSkills, skillId]);
    }
  };

  const selectedSkillLabels = skills
    .filter(s => selectedSkills.includes(s.id))
    .map(s => s.label)
    .join(', ');

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Required Skills
      </label>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded mb-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        placeholder="Search skills..."
      />

      {/* Selected Skills Display */}
      {selectedSkills.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {skills
            .filter(s => selectedSkills.includes(s.id))
            .map(skill => (
              <span
                key={skill.id}
                className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm flex items-center gap-2"
              >
                {skill.label}
                <button
                  type="button"
                  onClick={() => handleToggle(skill.id)}
                  className="hover:text-blue-900"
                >
                  ✕
                </button>
              </span>
            ))}
        </div>
      )}

      {/* Dropdown */}
      {search.length > 0 && (
        <div className="border border-gray-300 rounded max-h-40 overflow-y-auto">
          {filteredSkills.map(skill => (
            <label
              key={skill.id}
              className="flex items-center p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={selectedSkills.includes(skill.id)}
                onChange={() => handleToggle(skill.id)}
                className="mr-2"
              />
              <span className="text-sm">{skill.label}</span>
            </label>
          ))}
          {filteredSkills.length === 0 && (
            <div className="p-2 text-sm text-gray-500">No skills found</div>
          )}
        </div>
      )}
    </div>
  );
}
