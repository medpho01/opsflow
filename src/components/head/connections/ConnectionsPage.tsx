"use client";

/**
 * Connections — labs, stores and their WhatsApp groups, in one place.
 *
 * Onboarding is the same three steps for everyone: add the ops number to their
 * group, Connect, pick the lab or store. Connecting sets everything (reading
 * the group; for a lab, its messages: standard set, combined, coordinator).
 *   Labs    every LabStack lab: group, messages on/off, manager, coordinator.
 *   Stores  every LabStack store: group, Ask ID.
 *   Groups  every WhatsApp group the ops number is in — "Not connected yet"
 *           is where new groups land.
 */
import { useEffect, useState } from "react";
import { NonApiLabConfigPanel } from "@/components/head/NonApiLabConfigPanel";
import { GroupsTab } from "./GroupsTab";
import { StoresTab } from "./StoresTab";

type Tab = "labs" | "stores" | "groups";
type Gateway = { status: string; connectedNumber: string | null };

export function ConnectionsPage({ initialTab }: { initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [gw, setGw] = useState<Gateway | null>(null);
  useEffect(() => { fetch("/api/whatsapp/gateway").then((r) => (r.ok ? r.json() : null)).then(setGw).catch(() => undefined); }, []);
  const choose = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", `/head/connections?tab=${next}`);
  };
  const linked = gw?.status === "CONNECTED";

  return (
    <div className="p-6 max-w-7xl">
      <div className="flex flex-wrap items-start gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">Connections</h1>
          <p className="text-sm text-zinc-400 mt-1">Labs, stores and their WhatsApp groups — one place to onboard and switch on.</p>
        </div>
        <a href="/head/settings/whatsapp" className={`ml-auto rounded-lg border px-3 py-2 text-xs ${linked ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>
          {linked ? <>WhatsApp linked · +{gw?.connectedNumber}</> : <>WhatsApp not linked — link it →</>}
        </a>
      </div>

      <details className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-4 text-sm" open>
        <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-zinc-500 font-semibold">Onboard a lab or store — 3 steps</summary>
        <ol className="mt-2 list-decimal pl-5 space-y-1 text-zinc-400">
          <li>Add the ops WhatsApp number{gw?.connectedNumber ? <> (+{gw.connectedNumber})</> : null} to their WhatsApp group.</li>
          <li>Find the lab or store below (or the group under <b className="text-zinc-300">WhatsApp groups → Not connected yet</b>) and click <b className="text-zinc-200">Connect</b>.</li>
          <li>Confirm the suggested match. Done: the group is read, and a lab gets its messages and is active. Optional, later: the lab manager&apos;s number or coordinators (Labs → Edit).</li>
        </ol>
      </details>

      <div className="flex gap-1 border-b border-zinc-800 mb-4">
        {([["labs", "Labs"], ["stores", "Stores"], ["groups", "WhatsApp groups"]] as const).map(([key, label]) => (
          <button key={key} onClick={() => choose(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === key ? "border-blue-500 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "labs" && <NonApiLabConfigPanel />}
      {tab === "stores" && <StoresTab />}
      {tab === "groups" && <GroupsTab initialShow="UNCONNECTED" />}
    </div>
  );
}
