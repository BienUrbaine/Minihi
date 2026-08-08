/* global L */

const COMPLETION_ENDPOINT = "https://data.geopf.fr/geocodage/completion/";
const TERRITORY = "22,29,35,56";

const addressInput = document.querySelector("#address-input");
const suggestionsBox = document.querySelector("#suggestions");
const spinner = document.querySelector("#search-spinner");
const resultBox = document.querySelector("#result");
const mapStatus = document.querySelector("#map-status");
const manualButton = document.querySelector("#manual-button");

const perimeterStyle = {
  stroke: false,
  fillColor: "#f36a2f",
  fillOpacity: 0.34,
};

const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([47.92, -3.83], 10);

const mapElement = document.querySelector("#map");
const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
resizeObserver.observe(mapElement);
window.addEventListener("load", () => {
  window.setTimeout(() => map.invalidateSize({ pan: false }), 100);
});

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerIcon = L.divIcon({
  className: "",
  html: '<div class="address-marker"></div>',
  iconSize: [34, 40],
  iconAnchor: [17, 38],
});

let features = [];
let perimeterLayer = null;
let addressMarker = null;
let requestController = null;
let debounceTimer = null;
let suggestionResults = [];
let activeSuggestionIndex = -1;
let manualMode = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function deviceName(feature) {
  return feature.properties?.Dispositif || "Dispositif non renseigné";
}

function communeName(feature) {
  return feature.properties?.Commune || "Commune non renseignée";
}

function popupContent(feature) {
  return `
    <div class="popup-label">Dispositif d’aide</div>
    <div class="popup-title">${escapeHtml(deviceName(feature))}</div>
    <div class="popup-commune">${escapeHtml(communeName(feature))}</div>
  `;
}

async function loadPerimeters() {
  if ("DecompressionStream" in window) {
    const compressed = await fetch("./data/perimetres.geojson.gz");
    if (compressed.ok) {
      if (compressed.headers.get("content-encoding") === "gzip") {
        return compressed.json();
      }
      const decompressed = compressed.body.pipeThrough(
        new DecompressionStream("gzip"),
      );
      return new Response(decompressed).json();
    }
  }
  const response = await fetch("./data/perimetres.geojson");
  if (!response.ok) throw new Error("Impossible de charger les périmètres.");
  return response.json();
}

loadPerimeters()
  .then((data) => {
    features = data.features || [];
    perimeterLayer = L.geoJSON(data, {
      style: perimeterStyle,
      onEachFeature(feature, layer) {
        layer.bindPopup(popupContent(feature));
        layer.bindTooltip(deviceName(feature), {
          sticky: true,
          direction: "top",
          opacity: 0.95,
        });
        layer.on("click", (event) => {
          if (!manualMode) return;
          layer.closePopup();
          locatePoint(
            event.latlng.lng,
            event.latlng.lat,
            "Point choisi sur la carte",
          );
          leaveManualMode();
        });
      },
    }).addTo(map);
    if (perimeterLayer.getBounds().isValid()) {
      map.fitBounds(perimeterLayer.getBounds(), { padding: [28, 28] });
    }
    window.setTimeout(() => {
      map.invalidateSize({ pan: false });
      map.fitBounds(perimeterLayer.getBounds(), { padding: [28, 28] });
    }, 120);
    mapStatus.textContent = `${features.length} périmètres chargés`;
  })
  .catch((error) => {
    mapStatus.textContent = "Périmètres indisponibles";
    showError(error.message);
  });

function pointOnSegment(point, start, end, tolerance = 1e-10) {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSquared <= tolerance ** 2) {
    return (x - x1) ** 2 + (y - y1) ** 2 <= tolerance ** 2;
  }
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  if (Math.abs(cross) > tolerance) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < -tolerance) return false;
  return dot <= lengthSquared + tolerance;
}

function ringContainsPoint(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (pointOnSegment(point, ring[j], ring[i])) return "boundary";
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, point) {
  if (!polygon.length) return false;
  const shell = ringContainsPoint(polygon[0], point);
  if (shell === "boundary") return true;
  if (!shell) return false;
  for (const hole of polygon.slice(1)) {
    const holeResult = ringContainsPoint(hole, point);
    if (holeResult === "boundary") return true;
    if (holeResult) return false;
  }
  return true;
}

function featureContainsPoint(feature, point) {
  const geometry = feature.geometry;
  if (!geometry) return false;
  if (geometry.type === "Polygon") {
    return polygonContainsPoint(geometry.coordinates, point);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) =>
      polygonContainsPoint(polygon, point),
    );
  }
  return false;
}

function showFound(label, matches) {
  const matchMarkup = matches
    .map(
      (feature) => `
        <article class="match">
          <p class="field-label">Dispositif</p>
          <p class="device-name">${escapeHtml(deviceName(feature))}</p>
          <div class="commune-row">
            <span>${escapeHtml(communeName(feature))}</span>
            <span class="fid">fid ${escapeHtml(feature.properties?.fid ?? "—")}</span>
          </div>
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
  `;
}

function showOutside(label) {
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
  `;
}

function showError(message) {
  resultBox.className = "result result-error";
  resultBox.innerHTML = `
    <div class="result-heading">
      <span class="result-symbol" aria-hidden="true">!</span>
      <div>
        <p class="result-label">Recherche impossible</p>
        <h2>${escapeHtml(message)}</h2>
      </div>
    </div>
  `;
}

function locatePoint(longitude, latitude, label) {
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

  if (matches.length) showFound(label, matches);
  else showOutside(label);
}

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
  };
}

function closeSuggestions() {
  suggestionsBox.classList.remove("visible");
  suggestionsBox.innerHTML = "";
  activeSuggestionIndex = -1;
  addressInput.removeAttribute("aria-activedescendant");
}

function renderSuggestions() {
  if (!suggestionResults.length) {
    suggestionsBox.innerHTML =
      '<div class="suggestion"><strong>Aucune adresse trouvée</strong><small>Essayez avec le nom de la commune ou du lieu-dit.</small></div>';
    suggestionsBox.classList.add("visible");
    return;
  }
  suggestionsBox.innerHTML = suggestionResults
    .map(
      (item, index) => `
        <button class="suggestion" id="suggestion-${index}" type="button" role="option" data-index="${index}">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml([item.postcode, item.city].filter(Boolean).join(" · "))}</small>
        </button>
      `,
    )
    .join("");
  suggestionsBox.classList.add("visible");
}

async function searchAddresses(query) {
  if (requestController) requestController.abort();
  requestController = new AbortController();
  spinner.classList.add("visible");
  const params = new URLSearchParams({
    text: query,
    type: "StreetAddress",
    maximumResponses: "8",
    terr: TERRITORY,
  });

  try {
    const response = await fetch(`${COMPLETION_ENDPOINT}?${params}`, {
      signal: requestController.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Le service d’adresses ne répond pas.");
    const payload = await response.json();
    suggestionResults = (payload.results || [])
      .map(normalizeSuggestion)
      .filter(Boolean);
    renderSuggestions();
  } catch (error) {
    if (error.name !== "AbortError") {
      suggestionResults = [];
      closeSuggestions();
      showError("Le service d’adresses est momentanément indisponible.");
    }
  } finally {
    spinner.classList.remove("visible");
  }
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
  );
}

addressInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const query = addressInput.value.trim();
  if (query.length < 3) {
    closeSuggestions();
    return;
  }
  debounceTimer = setTimeout(() => searchAddresses(query), 320);
});

addressInput.addEventListener("keydown", (event) => {
  if (!suggestionsBox.classList.contains("visible") || !suggestionResults.length)
    return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex + 1) % suggestionResults.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestionIndex =
      (activeSuggestionIndex - 1 + suggestionResults.length) %
      suggestionResults.length;
  } else if (event.key === "Enter" && activeSuggestionIndex >= 0) {
    event.preventDefault();
    selectSuggestion(activeSuggestionIndex);
    return;
  } else if (event.key === "Escape") {
    closeSuggestions();
    return;
  } else {
    return;
  }
  document.querySelectorAll(".suggestion").forEach((element, index) => {
    element.classList.toggle("active", index === activeSuggestionIndex);
  });
  addressInput.setAttribute(
    "aria-activedescendant",
    `suggestion-${activeSuggestionIndex}`,
  );
});

suggestionsBox.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (button) selectSuggestion(Number(button.dataset.index));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-shell")) closeSuggestions();
});

manualButton.addEventListener("click", () => {
  manualMode = !manualMode;
  document.body.classList.toggle("manual-mode", manualMode);
  manualButton.classList.toggle("active", manualMode);
  manualButton.setAttribute("aria-pressed", String(manualMode));
  mapStatus.textContent = manualMode
    ? "Cliquez sur la carte pour tester un point"
    : `${features.length} périmètres chargés`;
});

function leaveManualMode() {
  manualMode = false;
  document.body.classList.remove("manual-mode");
  manualButton.classList.remove("active");
  manualButton.setAttribute("aria-pressed", "false");
  mapStatus.textContent = `${features.length} périmètres chargés`;
}

map.on("click", (event) => {
  if (!manualMode) return;
  const { lng, lat } = event.latlng;
  locatePoint(lng, lat, "Point choisi sur la carte");
  leaveManualMode();
});
