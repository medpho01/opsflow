"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import StatusBadge from "@/components/shared/StatusBadge";
import PriorityBadge from "@/components/shared/PriorityBadge";

interface SearchResult {
  id: number;
  title: string;
  status: string;
  priority: string;
  entityId: number;
  orderType: string;
  slaDeadline: string;
  assignedTo: { id: number; name: string } | null;
}

export default function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const search = useCallback(async (q: string) => {
    if (!q.trim() || q.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setResults(data.tasks ?? []);
      setOpen(true);
      setActiveIdx(-1);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 300);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  function handleSelect(task: SearchResult) {
    setQuery("");
    setOpen(false);
    setResults([]);
    // Navigate to the task — for head it's /head/tasks, for agent it's /agent
    router.push(`/head/tasks?taskId=${task.id}`);
  }

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+K to focus
  useEffect(() => {
    function handleGlobal(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", handleGlobal);
    return () => document.removeEventListener("keydown", handleGlobal);
  }, []);

  return (
    <div ref={containerRef} className="relative w-56">
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search tasks…"
          className="w-full h-8 pl-8 pr-8 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
        />
        {/* Kbd hint */}
        {!query && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-0.5">
            <kbd className="text-[9px] text-zinc-600 font-mono bg-zinc-800 px-1 py-0.5 rounded border border-zinc-700">⌘K</kbd>
          </div>
        )}
        {/* Spinner */}
        {loading && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
            <div className="w-3 h-3 border border-zinc-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-zinc-500 text-center">No results found</div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {results.map((task, idx) => (
                <button
                  key={task.id}
                  onClick={() => handleSelect(task)}
                  className={`w-full text-left px-3 py-2.5 transition-colors border-b border-zinc-800 last:border-0 ${
                    idx === activeIdx ? "bg-blue-600/15" : "hover:bg-zinc-800"
                  }`}
                >
                  <div className="flex items-start gap-2 mb-1">
                    <span className="flex-1 text-xs text-zinc-200 font-medium leading-snug line-clamp-1">
                      {task.title}
                    </span>
                    <PriorityBadge priority={task.priority} />
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={task.status} />
                    <span className="text-[10px] text-zinc-600">#{task.entityId}</span>
                    {task.assignedTo && (
                      <span className="text-[10px] text-zinc-600 ml-auto truncate max-w-20">{task.assignedTo.name}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
          <div className="px-3 py-1.5 border-t border-zinc-800 flex items-center gap-3 text-[10px] text-zinc-600">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> select</span>
            <span><kbd className="font-mono">Esc</kbd> close</span>
          </div>
        </div>
      )}
    </div>
  );
}
