/**
 * The provenance a reply inherits. The parent's own idVia is kept only when it
 * names the id actually inherited; otherwise it is rebuilt from that id, so a
 * row's orderIds[0] and its idVia never disagree (seen on 24 Oct 2026:
 * "reply · order 93709" on a row tagged 90381).
 */
export function inheritedVia(parent, orderId, requestId) {
  const named = parent.idVia && parent.idVia.match(/\b(order|request|appt) (\d+)/i);
  const consistent = named && ((orderId && named[1].toLowerCase() === "order" && +named[2] === +orderId) || (requestId && named[1].toLowerCase() === "request" && +named[2] === +requestId) || named[1].toLowerCase() === "appt");
  if (parent.idVia && (consistent || !named)) return parent.idVia;
  return orderId ? `order ${orderId}` : `request ${requestId}`;
}

