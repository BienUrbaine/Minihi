/* global L */

const COMPLETION_ENDPOINT = "https://data.geopf.fr/geocodage/completion/";
const TERRITORY = "22,29,35,56";

const addressInput = document.querySelector("#address-input");
const suggestionsBox = document.querySelector("#suggestions");
const spinner = document.querySelector("#search-spinner");
const resultBox = document.querySelector("#result");
const mapStatus = document.querySelector("#map-status");

const perimeterStyle = {
  stroke: true,
  color: "#8f2f08",
  weight: 1.4,
  opacity: 0.9,
  fillColor: "#c84a0a",
  fillOpacity: 0.52,
};

const perimeterHoverStyle = {
  color: "#782300",
  weight: 2,
  fillColor: "#d95712",
  fillOpacity: 0.72,
};

function setMapStatus(message = "") {
  mapStatus.textContent = message;
  mapStatus.hidden = !message;
}

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

L.control
  .scale({
    position: "bottomright",
    imperial: false,
    maxWidth: 110,
  })
  .addTo(map);

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function propertyValue(feature, name, fallback = "Non renseigné") {
  const value = feature.properties?.[name];
  if (value === null || value === undefined || String(value).trim() === "") {
    return fallback;
  }
  return String(value).trim();
}

function deviceName(feature) {
  return propertyValue(feature, "Label", "Dispositif non renseigné");
}

function deviceType(feature) {
  return propertyValue(feature, "Type");
}

function projectOwner(feature) {
  return propertyValue(feature, "Maitre_ouvrage");
}

function formatDate(value) {
  if (!value) return "Non renseignée";
  const parts = String(value).split("-");
  if (parts.length === 3) {
    const [year, month, day] = parts;
    return `${day}/${month}/${year}`;
  }
  return String(value);
}

function dateRange(feature) {
  const start = formatDate(feature.properties?.Date_debut);
  const end = formatDate(feature.properties?.Date_fin);
  return `du ${start} au ${end}`;
}

function popupContent(feature) {
  return `
    <div class="popup-title">${escapeHtml(deviceName(feature))}</div>
    <div class="popup-commune"><strong>Type :</strong> ${escapeHtml(deviceType(feature))}</div>
    <div class="popup-commune"><strong>Date :</strong> ${escapeHtml(dateRange(feature))}</div>
    <div class="popup-commune"><strong>Maître d’ouvrage :</strong> ${escapeHtml(projectOwner(feature))}</div>
  `;
}

async function loadPerimeters() {
  const response = await fetch("./data/perimetres.geojson", { cache: "no-store" });
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
        layer.on({
          mouseover() {
            layer.setStyle(perimeterHoverStyle);
            layer.bringToFront();
          },
          mouseout() {
            layer.setStyle(perimeterStyle);
          },
        });
      },
    }).addTo(map);
    if (perimeterLayer.getBounds().isValid()) {
      map.fitBounds(perimeterLayer.getBounds(), { padding: [28, 28] });
    }
    window.setTimeout(() => {
      map.invalidateSize({ pan: false });
      if (perimeterLayer.getBounds().isValid()) {
        map.fitBounds(perimeterLayer.getBounds(), { padding: [28, 28] });
      }
    }, 120);
    setMapStatus();
  })
  .catch((error) => {
    setMapStatus("Périmètres indisponibles");
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
