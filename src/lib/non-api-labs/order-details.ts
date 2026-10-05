/**
 * What a provider needs to actually serve an order: who, how to reach them,
 * where, and which tests. The confirmation message and the evening list both
 * carry these, and neither is usable without them.
 *
 * LabStack keeps the patient's address on their Profile (one row per User,
 * `Profile.profileUserId`), not on the order. That means the message shows the
 * address as it is NOW — an edit after booking is reflected — which is right
 * for messages sent within a day or two of the booking.
 *
 * The formatting helpers are pure and exported for tests; the read is one
 * batched, primary-key-bounded query on the API pool.
 */
import { labstack, labstackOr } from "@/lib/db/labstack";

export type OrderContactDetails = {
  orderId: number;
  patientMobile: string | null;
  /** Full street address, composed by composePatientAddress. */
  address: string | null;
  /** Short place name for a one-line list: locality, else city. */
  area: string | null;
  mapUrl: string | null;
  tests: string | null;
};

type AddressParts = {
  unitFloorBuilding?: string | null;
  address?: string | null;
  locality?: string | null;
  city?: string | null;
  pincode?: string | null;
};

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * "[flat], [address], [locality], [city] – [pincode]".
 *
 * Patients often type locality, city or pincode into the street line itself;
 * any part already present there is dropped so the message never reads
 * "Indiranagar, Bengaluru, Bengaluru – 560038".
 */
export function composePatientAddress(parts: AddressParts): string | null {
  const street = clean(parts.address);
  const haystack = street.toLowerCase();
  const fresh = (value: string) => value && !haystack.includes(value.toLowerCase());

  const unit = clean(parts.unitFloorBuilding);
  const locality = clean(parts.locality);
  const city = clean(parts.city);
  const pincode = clean(parts.pincode);

  const head = [fresh(unit) ? unit : "", street, fresh(locality) ? locality : "", fresh(city) ? city : ""]
    .filter(Boolean)
    .join(", ");
  const tail = fresh(pincode) ? pincode : "";
  const full = head && tail ? `${head} – ${tail}` : head || tail;
  return full || null;
}

/** Pin on the saved coordinates when we have them, else a search on the address. */
export function mapUrlFor(latitude: number | null | undefined, longitude: number | null | undefined, address: string | null): string | null {
  const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value !== 0;
  if (valid(latitude) && valid(longitude)) {
    return `https://maps.google.com/?q=${Number(latitude).toFixed(6)},${Number(longitude).toFixed(6)}`;
  }
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
}

/**
 * The provider-facing contact fields, with readable fallbacks: the renderer
 * refuses an empty variable, and a missing mobile must not stop the lab from
 * hearing about the order at all.
 */
export function contactVariables(details: Pick<OrderContactDetails, "patientMobile" | "address" | "mapUrl"> | null | undefined) {
  return {
    patient_mobile: details?.patientMobile || "Not on file",
    patient_address: details?.address || "Address not on file – please check LabStack",
    map_url: details?.mapUrl || "Map not available",
  };
}

type DetailsRow = {
  id: number;
  mobile: string | null;
  unitFloorBuilding: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  tests: string | null;
};

const DETAILS_DEADLINE_MS = 5_000;

/**
 * Contact details for a batch of orders, keyed by order id.
 *
 * Returns null when LabStack could not be read — "unknown", which callers
 * must treat as retry-later rather than as an order with no details.
 */
export async function fetchOrderContactDetails(ids: number[]): Promise<Map<number, OrderContactDetails> | null> {
  const unique = Array.from(new Set(ids.filter((id) => Number.isInteger(id))));
  if (unique.length === 0) return new Map();

  const query = labstack.$queryRawUnsafe<DetailsRow[]>(
    `SELECT o.id,
            u.mobile,
            p."unitFloorBuilding", p.address, p.locality, p.city, p.pincode::text AS pincode,
            p.latitude, p.longitude,
            (SELECT string_agg(pk."packageName", ', ' ORDER BY pk."packageName")
               FROM public."_OrderToPackage" op
               JOIN public."Package" pk ON pk.id = op."B"
              WHERE op."A" = o.id) AS tests
       FROM public."Order" o
       LEFT JOIN public."User" u    ON u.id = o."userId"
       LEFT JOIN public."Profile" p ON p."profileUserId" = o."userId"
      WHERE o.id = ANY($1::int[])`,
    unique,
  );
  const rows = await labstackOr<DetailsRow[] | null>(query, null, DETAILS_DEADLINE_MS, { breakerKey: "api" });
  if (rows === null) return null;

  return new Map(rows.map((row) => {
    const address = composePatientAddress(row);
    return [row.id, {
      orderId: row.id,
      patientMobile: clean(row.mobile) || null,
      address,
      area: clean(row.locality) || clean(row.city) || null,
      mapUrl: mapUrlFor(row.latitude, row.longitude, address),
      tests: clean(row.tests) || null,
    }];
  }));
}
