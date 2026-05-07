import AlertBell from "./AlertBell";
import SearchBar from "./SearchBar";
import { AuthUser } from "@/types";
import Link from "next/link";

interface TopBarProps {
  user: AuthUser;
}

export default function TopBar({ user }: TopBarProps) {
  return (
    <div className="h-11 shrink-0 border-b border-zinc-800 bg-zinc-950 px-5 flex items-center justify-between gap-4">
      {/* Left: breadcrumb placeholder */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-600 shrink-0">
        <span className="text-zinc-500 font-medium">OpsFlow</span>
      </div>

      {/* Center: search */}
      <div className="flex-1 flex justify-center max-w-xs">
        <SearchBar />
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-1 shrink-0">
        <AlertBell />
        <Link
          href="/profile"
          className="p-2 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          title="Profile & Settings"
        >
          <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
