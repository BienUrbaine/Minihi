/* Compléments de recherche Minihi — aucune donnée de ce fichier n'est ajoutée à la carte. */

const COMPLEMENTARY_FILES = {
  qpv: "./data/QPV_2024_Bretagne_WGS84.geojson",
  abc: "./data/zonage_abc.json",
  zonage123: "./data/zonage_123.json",
  denormandie: "./data/denormandie_bretagne.geojson",
};

const complementaryData = {
  qpv: [],
  abc: {},
  zonage123: {},
  denormandie: new Set(),
};

function normalizeCityCodeValue(value) {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    const code = String(candidate ?? "").trim();
    if (/^\d{5}$/.test(code)) return code;
  }
  return "";
}

function cityCodeFromRawSuggestion(raw) {
  const directCandidates = [
    raw.citycode,
    raw.cityCode,
    raw.city_code,
    raw.insee,
    raw.insee_com,
  ];

  for (const candidate of directCandidates) {
    const code = normalizeCityCodeValue(candidate);
    if (code) return code;
  }

  const id = String(raw.id || "").trim();
  const idMatch = id.match(/^(\d{5})[_-]/);
  return idMatch ? idMatch[1] : "";
}

async function fetchComplementaryJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Impossible de charger ${path}`);
  return response.json();
}

async function loadComplementaryData() {
  const entries = Object.entries(COMPLEMENTARY_FILES);
  const results = await Promise.allSettled(
    entries.map(([, path]) => fetchComplementaryJson(path)),
  );

  results.forEach((result, index) => {
    const [key] = entries[index];
    if (result.status !== "fulfilled") {
      console.warn(`Donnée complémentaire indisponible : ${key}`, result.reason);
      return;
    }

    if (key === "qpv") {
      complementaryData.qpv = result.value.features || [];
    } else if (key === "abc") {
      complementaryData.abc = result.value || {};
    } else if (key === "zonage123") {
      complementaryData.zonage123 = result.value || {};
    } else if (key === "denormandie") {
      complementaryData.denormandie = new Set(
        (result.value.features || [])
          .filter((feature) => feature.properties?.denormandie === true)
          .map((feature) =>
            normalizeCityCodeValue(feature.properties?.code_insee),
          )
          .filter(Boolean),
      );
    }
  });
}

const complementaryLoadPromise = loadComplementaryData();

async function resolveCityCode(longitude, latitude, knownCityCode = "") {
  const normalizedKnownCode = normalizeCityCodeValue(knownCityCode);
  if (normalizedKnownCode) return normalizedKnownCode;

  const params = new URLSearchParams({
    index: "address",
    lon: String(longitude),
    lat: String(latitude),
    limit: "1",
  });

  try {
    const response = await fetch(
      `https://data.geopf.fr/geocodage/reverse?${params}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return "";
    const payload = await response.json();
    return normalizeCityCodeValue(
      payload.features?.[0]?.properties?.citycode,
    );
  } catch (error) {
    console.warn("Code INSEE de la commune indisponible", error);
    return "";
  }
}

function formatZonage123(value) {
  const labels = {
    1: "I",
    2: "II",
    3: "III",
  };
  return labels[String(value)] || String(value ?? "").trim();
}

function buildComplementaryRows(point, citycode) {
  const rows = [];

  const qpvNames = complementaryData.qpv
    .filter((feature) => featureContainsPoint(feature, point))
    .map((feature) => String(feature.properties?.lib_qp || "").trim())
    .filter(Boolean);

  const uniqueQpvNames = [...new Set(qpvNames)];
  if (uniqueQpvNames.length) {
    rows.push({
      label: "QPV",
      value: `Oui — ${uniqueQpvNames.join(", ")}`,
    });
  }

  if (citycode && Object.prototype.hasOwnProperty.call(complementaryData.abc, citycode)) {
    rows.push({
      label: "Zone ABC",
      value: String(complementaryData.abc[citycode]),
    });
  }

  if (
    citycode &&
    Object.prototype.hasOwnProperty.call(complementaryData.zonage123, citycode)
  ) {
    rows.push({
      label: "Zone I-II-III",
      value: formatZonage123(complementaryData.zonage123[citycode]),
    });
  }

  if (citycode && complementaryData.denormandie.has(citycode)) {
    rows.push({
      label: "Denormandie",
      value: "Commune éligible",
    });
  }

  return rows;
}

function complementaryMarkup(rows) {
  if (!rows.length) return "";

  const rowsMarkup = rows
    .map(
      (row) => `
        <div class="commune-row">
          <span><strong>${escapeHtml(row.label)} :</strong> ${escapeHtml(row.value)}</span>
        </div>
      `,
    )
    .join("");

  return `
    <div class="matches">
      <p class="field-label">Informations complémentaires</p>
      ${rowsMarkup}
    </div>
  `;
}

/*
 * Ces fonctions reprennent volontairement les points d'entrée d'app.js.
 * Le script est chargé après app.js : il enrichit la recherche sans modifier
 * la couche Leaflet des périmètres principaux.
 */
function normalizeSuggestion(raw) {
  const longitude = Number(raw.x);
  const latitude = Number(raw.y);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const label =
    String(raw.fulltext || "").trim() ||
    [raw.street, raw.city].filter(Boolean).join(", ") ||
    "Adresse sans libellé";
  return {
    label,
    longitude,
    latitude,
    city: String(raw.city || "").trim(),
    postcode: String(raw.zipcode || "").trim(),
    citycode: cityCodeFromRawSuggestion(raw),
  };
}

function showFound(label, matches, complementaryRows = []) {
  const matchMarkup = matches
    .map(
      (feature) => `
        <article class="match">
          <p class="field-label">Dispositif</p>
          <p class="device-name">${escapeHtml(deviceName(feature))}</p>
          <div class="commune-row"><span><strong>Type :</strong> ${escapeHtml(deviceType(feature))}</span></div>
          <div class="commune-row"><span><strong>Période :</strong> ${escapeHtml(dateRange(feature))}</span></div>
          <div class="commune-row"><span><strong>Maître d’ouvrage :</strong> ${escapeHtml(projectOwner(feature))}</span></div>
        </article>
      `,
    )
    .join("");

  resultBox.className = "result result-found";
  resultBox.innerHTML = `
    <div class="result-heading">
      <span class="result-symbol" aria-hidden="true">✓</span>
      <div>
        <p class="result-label">Périmètre trouvé</p>
        <h2>${matches.length > 1 ? `${matches.length} dispositifs applicables` : "Cette adresse est éligible"}</h2>
      </div>
    </div>
    <p class="address-confirmed">${escapeHtml(label)}</p>
    <div class="matches">${matchMarkup}</div>
    ${complementaryMarkup(complementaryRows)}
  `;
}

function showOutside(label, complementaryRows = []) {
  resultBox.className = "result result-outside";
  resultBox.innerHTML = `
    <div class="result-heading">
      <span class="result-symbol" aria-hidden="true">×</span>
      <div>
        <p class="result-label">Hors périmètre</p>
        <h2>Aucun dispositif trouvé à cette adresse</h2>
      </div>
    </div>
    <p class="address-confirmed">${escapeHtml(label)}</p>
    <p class="outside-copy">Le point recherché ne se situe dans aucun des périmètres actuellement publiés.</p>
    ${complementaryMarkup(complementaryRows)}
  `;
}

async function locatePoint(longitude, latitude, label, knownCityCode = "") {
  const point = [longitude, latitude];
  const matches = features.filter((feature) =>
    featureContainsPoint(feature, point),
  );

  if (addressMarker) {
    addressMarker.setLatLng([latitude, longitude]);
  } else {
    addressMarker = L.marker([latitude, longitude], { icon: markerIcon }).addTo(map);
  }
  addressMarker.bindTooltip(label, { direction: "top", offset: [0, -30] });
  map.flyTo([latitude, longitude], 16, { duration: 0.75 });

  await complementaryLoadPromise;
  const citycode = await resolveCityCode(longitude, latitude, knownCityCode);
  const complementaryRows = buildComplementaryRows(point, citycode);

  if (matches.length) showFound(label, matches, complementaryRows);
  else showOutside(label, complementaryRows);
}

function selectSuggestion(index) {
  const selected = suggestionResults[index];
  if (!selected) return;
  addressInput.value = selected.label;
  closeSuggestions();
  locatePoint(
    selected.longitude,
    selected.latitude,
    selected.label,
    selected.citycode,
  );
}
