import fetch from "node-fetch";

export async function enrichPoolWithBitquery(pool) {
  return { ...pool, bitqueryEnriched: false };
}

export function formatBitqueryContext(pool) {
  return "";
}
