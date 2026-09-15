// Canned Ladesäulenregister ArcGIS responses for the unit suite, shaped like the
// live FeatureServer.

export const stations = {
  objectIdFieldName: "OBJECTID",
  geometryType: "esriGeometryPoint",
  exceededTransferLimit: false,
  features: [
    {
      attributes: {
        ID: "1000000",
        Betreiber: "SWD AG",
        operator_companyName: "Stadtwerke Düsseldorf AG",
        "Straße": "Forststraße",
        Hausnummer: "29",
        Postleitzahl: "40597",
        Ort: "Düsseldorf",
        state: "Nordrhein-Westfalen",
        Typ: "Normalladeeinrichtung",
        Status: "In Betrieb",
        max_electric_power_station: "22",
        Anzahl_Ladepunkte: "2",
        coordinates_latitude: 51.169901,
        coordinates_longitude: 6.876787,
        OBJECTID: 1,
      },
    },
    {
      attributes: {
        ID: "1000001",
        Betreiber: "EnBW",
        Ort: "Berlin",
        state: "Berlin",
        Typ: "Schnellladeeinrichtung",
        Status: "In Betrieb",
        OBJECTID: 2,
      },
    },
  ],
};

/** A `returnCountOnly` response. */
export const countOnly = { count: 660 };

/** An ArcGIS logical error (HTTP 200 + `error`). */
export const arcgisError = {
  error: { code: 400, message: "Unable to complete operation.", details: ["Invalid field: BOGUS"] },
};

/** An `outStatistics` group-by response (used by countBy). */
export const countByState = {
  features: [
    { attributes: { state: "Bayern", count: 21969 } },
    { attributes: { state: "Nordrhein-Westfalen", count: 21697 } },
    { attributes: { state: "Baden-Württemberg", count: 18259 } },
  ],
};

/** The layer field metadata (used by `fields`). */
export const fields = {
  fields: [
    { name: "Betreiber", type: "esriFieldTypeString", alias: "Betreiber" },
    { name: "Ort", type: "esriFieldTypeString", alias: "Ort" },
    { name: "state", type: "esriFieldTypeString", alias: "state" },
  ],
};

/** A GeoJSON FeatureCollection (f=geojson). */
export const geojson = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { Betreiber: "SWD AG", Ort: "Düsseldorf" }, geometry: { type: "Point", coordinates: [6.876787, 51.169901] } },
  ],
};
