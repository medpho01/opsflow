"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError("All fields are required");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must be different from current password");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to change password");
      }

      setSuccess(true);
      // All sessions invalidated — redirect to login after 2s
      setTimeout(() => router.push("/login"), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="px-6 py-8 text-center">
        <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center mx-auto mb-3">
          <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-sm font-medium text-zinc-200">Password changed successfully</p>
        <p className="text-xs text-zinc-500 mt-1">You will be redirected to login…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        <p className="mt-1 text-[10px] text-zinc-600">Minimum 8 characters</p>
      </div>
      <div>
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          className="w-full px-3 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Password strength indicator */}
      {newPassword.length > 0 && (
        <div className="space-y-1">
          <div className="flex gap-1">
            {[8, 12, 16].map((len) => (
              <div
                key={len}
                className={`h-0.5 flex-1 rounded-full transition-colors ${
                  newPassword.length >= len
                    ? newPassword.length >= 16
                      ? "bg-emerald-500"
                      : newPassword.length >= 12
                      ? "bg-blue-500"
                      : "bg-amber-500"
                    : "bg-zinc-700"
                }`}
              />
            ))}
          </div>
          <p className="text-[10px] text-zinc-600">
            Strength: {newPassword.length >= 16 ? "Strong" : newPassword.length >= 12 ? "Good" : newPassword.length >= 8 ? "Minimum" : "Too short"}
          </p>
        </div>
      )}

      {error && (
        <div className="px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/40 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
      >
        {submitting && (
          <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        )}
        {submitting ? "Changing Password…" : "Change Password"}
      </button>
    </form>
  );
}
