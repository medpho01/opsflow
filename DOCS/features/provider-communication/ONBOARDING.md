# Onboarding a lab or store on WhatsApp

The same three steps for every lab and every store. Nothing else to configure.

1. **Add the ops WhatsApp number** (shown on Settings → WhatsApp) to the lab's or
   store's WhatsApp group.
2. In OpsFlow, **Settings → WhatsApp → Groups**, find the group (filter "Not
   connected yet") and click **Connect**.
3. **Pick the lab or store and confirm.** The closest match by group name is
   suggested and preselected; search by name or id if it isn't.

That one step (`lib/wa/connect.ts`) sets everything:

| Connected to | What happens |
|---|---|
| **Lab** | The console reads the group (provider group, mapped to the lab). The lab's message config is created and switched on: name and order channel (API / WhatsApp) from LabStack, the standard message set (Message Rules), combined messages, the coordinator to @mention picked automatically. |
| **Store** | The console reads the group (customer group, mapped to the store) and links its questions to the store. |
| **Internal** | LabStack's own team group: read by the console. |
| **Ignore** | Not read, not messaged. |

Optional, any time later on **Lab Config**: the lab manager's WhatsApp number
(for final reminders), or naming a different coordinator.

**One link, two doors.** Choosing a lab's group on Lab Config does the same
thing as Connect on Settings → WhatsApp; whichever you use, the other shows it.
A group belongs to one lab or store, and a lab has one group: connecting moves
the link, it never leaves two.

**To stop messaging a lab:** Lab Config → its Active toggle (the group is still
read). **To stop everything for a group:** Connect → Ignore.
