/**
 * Anonymised examples of how stores and labs actually write, from the
 * Oct 2026 chats (Plum, Orange, Thyrocare, Redcliffe). Ids, names and
 * phones are fictional; the phrasings are real. They teach the model the
 * form before any live examples exist, and they are the reader's evals.
 *
 * The repo is public: never add a real patient, phone or lab reference here.
 */
import type { Reading } from "./read";

export type Example = { side: "lab" | "store"; text: string; quoted?: string; expect: Partial<Reading> };

const S = (text: string, expect: Partial<Reading>, quoted?: string): Example => ({ side: "store", text, quoted, expect });
const L = (text: string, expect: Partial<Reading>, quoted?: string): Example => ({ side: "lab", text, quoted, expect });

export const EXAMPLES: Example[] = [
  // ── Store side ──
  S("90001 - urine samples not collected\nlet us know the slots available today", { orders: [{ orderId: 90001 }], samples: { urine: "missed" }, request: { kind: "slot" } }),
  S("blood is collected\nbut urine collection is not done\nlet us know the slots will have to schedule", { samples: { blood: "collected", urine: "missed" }, request: { kind: "slot" } }),
  S("90002 - Please schedule urine sample collection at 10:45 am", { orders: [{ orderId: 90002 }], samples: { urine: "missed" }, request: { kind: "reschedule", time: "10:45 am" } }),
  S("90003 - please reschedule to tomorrow at 8 am", { orders: [{ orderId: 90003 }], request: { kind: "reschedule", time: "tomorrow 8 am" } }),
  S("90004 - samples are not collected\nplease check the earliest", { orders: [{ orderId: 90004 }], samples: { blood: "missed" }, request: { kind: "status" } }),
  S("also please check with the lab that it be happen tomorrow", { request: { kind: "status" } }),
  S("checking", { ack: true, request: { kind: "none" } }),
  S("will check\ncan we reschedule it ?", { request: { kind: "reschedule" } }),
  S("90005 - Please cancel the health check", { orders: [{ orderId: 90005 }], request: { kind: "cancel" } }),
  S("user asked to cancel it he will rebook", { request: { kind: "cancel" } }),
  S("90006 - please share the complete reports\nlipid profile is still pending", { orders: [{ orderId: 90006 }], request: { kind: "report" } }),
  S("90007 - samples were collected\nbut lab team has cancelled it\nplease correct the status and upload the reports", { orders: [{ orderId: 90007 }], samples: { blood: "collected" }, request: { kind: "report" }, events: [{ kind: "note", value: "cancelled after collection" }] }),
  S("90008 - Kindly make sure that the samples will be collected by tomorrow without fail", { orders: [{ orderId: 90008 }], request: { kind: "status" } }),
  S("any updates ?", { request: { kind: "status" } }),
  S("Not serviceable with current network, check for alternate lab", { request: { kind: "serviceability" } }),
  S("Phlebo no-show and rude to a fasting user, need RCA", { request: { kind: "complaint" } }),
  S("Add Dengue, H1N1 to 90009", { orders: [{ orderId: 90009 }], request: { kind: "change_tests" } }),
  S("90010 - This user has booked these tests, he is asking if all the tests will be included in the package", { orders: [{ orderId: 90010 }], request: { kind: "other" } }),
  S("Thanks", { ack: true, request: { kind: "none" } }),
  S("90011 - user is asking why was his health check cancelled", { orders: [{ orderId: 90011 }], request: { kind: "status" } }),
  // Nudges on an open request (27 Oct 2026): a status ask with no id — the thread it quotes answers which order.
  S("is this done ??", { request: { kind: "status" } }),
  S("any updates ?", { request: { kind: "status" } }),
  S("90012 - reschedule to tomorrow same slot", { orders: [{ orderId: 90012 }], request: { kind: "reschedule" } }),
  S("90013 90014 Please share the invoices and scanner for these tests for payment", { orders: [{ orderId: 90013 }, { orderId: 90014 }], request: { kind: "other" } }),
  // ── Lab side ──
  L("VL000001 As per update customer not available", { orders: [{ labRef: "VL000001" }], events: [{ kind: "patient_unavailable", value: "customer not available" }] }),
  L("VL000002 serviced\nVL000003 Serviced", { orders: [{ labRef: "VL000002" }, { labRef: "VL000003" }], events: [{ kind: "sample_collected", value: "yes" }] }),
  L("Booking (ID: 19000001)\nsample collected", { orders: [{ labRef: "19000001" }], events: [{ kind: "sample_collected", value: "yes" }] }),
  L("Booking (ID: 19000002)\nRescheduled for tomorrow", { orders: [{ labRef: "19000002" }], events: [{ kind: "new_appointment_time", value: "tomorrow" }] }),
  L("As checked, the blood sample has been collected, and the urine sample will be collected by 12:15 pm", { samples: { blood: "collected", urine: "pending" }, events: [{ kind: "eta", value: "12:15 pm" }] }, "1. BLR000001 · #90001 · Patient · 98xxxxxx01 · Bengaluru · urine pending"),
  L("The appointment has been scheduled on 27th at 8:30 am.", { events: [{ kind: "confirmed", value: "yes" }, { kind: "new_appointment_time", value: "27th 8:30 am" }] }, "please confirm (1)\n1. BLR000002 · #90002 · Patient · Tue 27 Oct 8:30 am"),
  L("VL000004 As per update Techncian in customer house", { orders: [{ labRef: "VL000004" }], events: [{ kind: "eta", value: "technician at customer house" }] }),
  L("Kindly share the cx details", { request: { kind: "details" } }),
  L("Kindly share the registered contact number", { request: { kind: "details" } }),
  L("1. BLR000003 · #90003 · Patient · 98xxxxxx03 · Bengaluru · 6:30 am\nAs checked the sample collection is in progress.", { orders: [{ orderId: 90003 }], events: [{ kind: "eta", value: "collection in progress" }] }),
  L("Phlebo Ramesh 9876500000, reaching by 9:15 am", { events: [{ kind: "phlebo_name", value: "Ramesh" }, { kind: "phlebo_phone", value: "9876500000" }, { kind: "eta", value: "9:15 am" }] }),
  L("we cannot take this order today", { events: [{ kind: "cannot_fulfil", value: "cannot take this order today" }] }),
  L("VL000005 order was cancelled as per your request via chat kindly check the screenshot and share the prepaid order id", { orders: [{ labRef: "VL000005" }], events: [{ kind: "note", value: "cancelled as per request; asks for prepaid order id" }] }),
  L("ok will do", { events: [{ kind: "confirmed", value: "yes" }] }, "please confirm (1)\n1. #90004 · Patient · tomorrow 7:00 am"),
  L("Report shared on mail", { events: [{ kind: "report_shared", value: "yes" }] }),
  L("1 done, 2 not home", { events: [{ kind: "sample_collected", value: "yes" }, { kind: "patient_unavailable", value: "not home" }] }, "quick check — collected? (2)\n1. #90005 · Patient · 8:00 am\n2. #90006 · Patient · 8:30 am"),
  // 27 Oct 2026: a lab's one-word answers, a lab cancelling after collection, a lab asking us back.
  L("Collected ✅", { events: [{ kind: "sample_collected", value: "yes" }] }, "Patient · 98xxxxxx09 @coordinator Kindly update the sample collection status?"),
  L("Non serviceable", { events: [{ kind: "cannot_fulfil", value: "non serviceable" }] }, "517425 Is this serviceable -?"),
  L("Sample has been collected order shows cancelled kindly share us new pre paid order id so that we can complete the WOE", { events: [{ kind: "sample_collected", value: "yes" }, { kind: "note", value: "cancelled; needs a new prepaid order id" }] }),
  L("Could you please clarify the exact issue? is there anything pending from our end", { request: { kind: "other" }, events: [] }, "@coordinator still open: 1 🙏"),
];
