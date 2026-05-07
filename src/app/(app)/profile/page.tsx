import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import ChangePasswordForm from "@/components/profile/ChangePasswordForm";

export const metadata = { title: "Profile — OpsFlow" };

const ROLE_LABEL: Record<string, string> = {
  OPS_HEAD: "Ops Head",
  OPS_AGENT: "Ops Agent",
  STORE_ADMIN: "Store Admin",
};

export default async function ProfilePage() {
  const user = await getSession();
  if (!user) redirect("/login");

  return (
    <div className="p-6 max-w-lg">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white">Profile & Settings</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Manage your account</p>
      </div>

      {/* Account info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-base font-semibold text-zinc-300">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-200">{user.name}</div>
            <div className="text-xs text-zinc-500">{user.email}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
            {ROLE_LABEL[user.role] ?? user.role}
          </span>
          <span className="text-xs text-zinc-600">User ID #{user.id}</span>
        </div>
      </div>

      {/* Change password */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-zinc-200 mb-1">Change Password</h2>
        <p className="text-xs text-zinc-500 mb-4">
          After changing your password, all active sessions will be invalidated and you will need to log in again.
        </p>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
