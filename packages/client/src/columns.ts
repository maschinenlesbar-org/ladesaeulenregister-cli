// Columns the layer lists but never fills.
//
// `fields` lists 57 columns. Sixteen of them are null on every row: the per-connector
// `evses_*` columns (pipeline leftovers of the raw `F_response_body`), `documentDate`,
// `documentTime`, `json_type` and the connector columns of charge points 7–10 (the register
// fills at most six). A filter on one of them matches nothing and a group on one is a
// single null group, both with exit 0, which reads like an answer. Checked live with one
// `IS NOT NULL` count over all sixteen (0 rows; layer data last edited 2026-10-01).

/** The columns that are null on every row of the register (checked 2026-10-06). */
export const EMPTY_FIELDS: readonly string[] = [
  "evses_evse_connectors_connector___connector_type",
  "evses_evse_connectors_connector___max_electric_power_connector",
  "evses_evse___connectors_connector_connector_type",
  "evses_evse___connectors_connector_max_electric_power_connector",
  "evses_evse___connectors_connector___connector_type",
  "evses_evse___connectors_connector___max_electric_power_connector",
  "evses_evse___evse_id",
  "evses_evse___public_key",
  "evses_evse___public_key_available",
  "documentDate",
  "documentTime",
  "json_type",
  "Steckersystem_Ladepunkt7",
  "Steckersystem_Ladepunkt8",
  "Steckersystem_Ladepunkt9",
  "Steckersystem_Ladepunkt10",
];

/**
 * The `EMPTY_FIELDS` that `text` (a `where` clause, an `orderBy`, an `outFields` list or a
 * `countBy` field) names, as whole identifiers and ignoring case, in `EMPTY_FIELDS` order.
 * `Steckersystem_Ladepunkt1` does not count as `Steckersystem_Ladepunkt10`.
 */
export function emptyFieldsIn(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  return EMPTY_FIELDS.filter((name) => new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`, "i").test(text));
}
