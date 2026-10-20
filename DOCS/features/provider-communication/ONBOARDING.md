# Onboarding a lab or store — Connections

Everything about labs, stores and their WhatsApp groups is on one page:
**Connections** (sidebar → Provider Communication → Connections,
`/head/connections`). Settings → WhatsApp only links the phone (QR) and keeps
the team roster.

## The same three steps for every lab and store

1. **Add the ops WhatsApp number** (shown at the top of Connections) to the
   lab's or store's WhatsApp group.
2. On **Connections**, find the lab (Labs tab) or store (Stores tab) and click
   **Connect** — or start from the group: **WhatsApp groups → Not connected
   yet** → Connect.
3. **Confirm the suggested match** (best name match preselected; search by
   name or id otherwise).

That one step (`lib/wa/connect.ts`) sets everything:

| Connected to | What happens |
|---|---|
| **Lab** | The group is read by the console (provider group, mapped to the lab). The lab is switched on: name and order channel from LabStack, the standard message set, combined messages, the coordinator picked automatically. |
| **Store** | The group is read by the console (customer group, mapped to the store); questions link to the store. "Ask ID" lets the console ask the store for an order id. |
| **Internal** / **Ignore** | LabStack's own team group (read) / not read, not messaged. |

Optional, any time: the lab manager's WhatsApp number (Labs → Edit) for final
reminders; a different coordinator; pausing a lab's messages (Labs → Active).

## Rules that keep it one set

- A group belongs to one lab or store; a lab has one group. Connecting moves
  the link — it never leaves two.
- Starting from the lab, the store or the group is the same action; every tab
  shows the same truth.
- On first deploy, links made before Connections existed are aligned once
  (`alignExistingConnections`): labs' chosen groups become their provider
  groups; groups mapped to a lab only in WhatsApp Settings give that lab a
  config with messages **off**; store conflicts and duplicate claims are left
  alone and logged (`[Connect] Existing group links aligned: …`).
