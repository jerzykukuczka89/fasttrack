const caseInfo = {
  suspectAlias: "피의자 A",
  limitationExpiresAt: new Date("2026-09-30T18:00:00+09:00"),
  arrestWarrantExpiresAt: new Date("2026-04-30T23:59:00+09:00"),
  detentionWarrantExpiresAt: null,
};

const STAY_DETECT_OPTIONS = {
  minStayMinutes: 10,
  radiusMeters: 120,
};

let currentPings = buildSamplePings();
let currentStaySegments = detectStaySegments(currentPings, STAY_DETECT_OPTIONS);

let map;
let overlayLayer;
const geocodeCache = new Map();
const stayLocationCache = new Map();
let renderRequestSeq = 0;
let latestBlinkTimer = null;

initMap();

function initMap() {
  map = L.map("map", {
    zoomControl: true,
  }).setView([36.5019, 127.2623], 15);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  overlayLayer = L.layerGroup().addTo(map);

  renderCaseInfo();
  renderTrack();
  renderStayList();
  bindInputActions();
  setDefaultInputText();
}

function renderCaseInfo() {
  document.getElementById("limitationDate").textContent = formatDate(caseInfo.limitationExpiresAt);
  document.getElementById("arrestDate").textContent = formatDateOrBlank(caseInfo.arrestWarrantExpiresAt);
  document.getElementById("detentionDate").textContent = formatDateOrBlank(caseInfo.detentionWarrantExpiresAt);
}

async function renderTrack() {
  const requestId = ++renderRequestSeq;
  clearLatestBlink();
  overlayLayer.clearLayers();

  if (!currentPings.length) {
    return;
  }

  const fallbackPath = currentPings.map((ping) => [ping.lat, ping.lng]);
  const path = await buildRoadAwarePath(currentPings);
  if (requestId !== renderRequestSeq) {
    return;
  }
  const finalPath = path.length >= 2 ? path : fallbackPath;

  const redPath = L.polyline(finalPath, {
    color: "#ff0000",
    weight: 4,
    opacity: 0.75,
  }).addTo(overlayLayer);

  // 속도 시각화를 위해 구간별 보조선/아이콘을 추가
  const movement = buildMovementAnalytics(currentPings);
  renderSpeedOverlays(movement);

  map.fitBounds(redPath.getBounds(), {
    padding: [30, 30],
  });

  currentStaySegments.forEach((segment) => {
    const bucket = durationBucket(segment.durationMinutes);
    const style = markerStyleByDuration(segment.durationMinutes);

    const marker = L.circleMarker([segment.centerLat, segment.centerLng], {
      radius: bucket.radius,
      color: style.stroke,
      fillColor: style.fill,
      fillOpacity: style.opacity,
      weight: 2,
    }).addTo(overlayLayer);

    marker.bindPopup(`
      <div style="font-size:13px;line-height:1.4;">
        <strong>체류 시간</strong>: ${segment.durationMinutes}분 (${bucket.label})<br>
        ${formatDate(segment.start)} ~ ${formatDate(segment.end)}
      </div>
    `);
  });

  hydrateStayLocations();
  renderLatestBlinkMarker();
}

function renderLatestBlinkMarker() {
  if (!currentPings.length) {
    return;
  }

  const last = currentPings[currentPings.length - 1];
  const marker = L.circleMarker([last.lat, last.lng], {
    radius: 12,
    color: "#047857",
    fillColor: "#22c55e",
    fillOpacity: 0.95,
    weight: 3,
  }).addTo(overlayLayer);

  marker.bindPopup(`<strong>최종 위치</strong><br>${formatDate(last.timestamp)}`);

  let visible = true;
  latestBlinkTimer = setInterval(() => {
    visible = !visible;
    marker.setStyle({
      fillOpacity: visible ? 0.95 : 0.15,
      opacity: visible ? 1 : 0.3,
    });
  }, 1000);
}

function clearLatestBlink() {
  if (latestBlinkTimer) {
    clearInterval(latestBlinkTimer);
    latestBlinkTimer = null;
  }
}

function isBlockedForCarIcon(lat, lng) {
  // 세종호수/중앙공원 내부에서는 차량 아이콘 오탐을 막는다.
  // 1) 호수 수면 영역(확장 bbox)
  if (lat >= 36.4989 && lat <= 36.5024 && lng >= 127.2824 && lng <= 127.2879) {
    return true;
  }

  // 2) 공원 내부 보행구역 폴리곤
  const blockedPolygons = [
    [
      [36.5029, 127.2818],
      [36.5028, 127.2844],
      [36.5018, 127.2867],
      [36.5006, 127.2879],
      [36.4992, 127.2876],
      [36.4986, 127.2857],
      [36.4990, 127.2833],
      [36.5001, 127.2819],
      [36.5016, 127.2814],
    ],
    [
      [36.5006, 127.2840],
      [36.5005, 127.2898],
      [36.4980, 127.2900],
      [36.4979, 127.2839],
    ],
  ];

  return blockedPolygons.some((polygon) => isPointInPolygon(lat, lng, polygon));
}

function isPointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const yi = polygon[i][0];
    const xi = polygon[i][1];
    const yj = polygon[j][0];
    const xj = polygon[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;

    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function renderSpeedOverlays(movement) {
  let lastCarMarkerLatLng = null;
  let lastBusMarkerLatLng = null;

  movement.segments.forEach((segment) => {
    if (segment.mode === "car") {
      const markerPos = [segment.to.lat, segment.to.lng];
      if (isBlockedForCarIcon(markerPos[0], markerPos[1])) {
        return;
      }

      // 자동차 아이콘이 너무 촘촘하게 붙지 않게 최소 거리 조건 적용
      if (
        !lastCarMarkerLatLng ||
        distanceMeters(lastCarMarkerLatLng[0], lastCarMarkerLatLng[1], markerPos[0], markerPos[1]) > 300
      ) {
        const carIcon = L.divIcon({
          className: "mode-icon",
          html: "🚗",
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });

        L.marker(markerPos, { icon: carIcon })
          .addTo(overlayLayer)
          .bindPopup(
            `<strong>차량 이동 추정</strong><br>속도: ${segment.speedKmh.toFixed(1)} km/h<br>${formatDate(segment.to.timestamp)}`,
          );

        lastCarMarkerLatLng = markerPos;
      }
    }
  });

  movement.busStops.forEach((stop) => {
    const markerPos = [stop.lat, stop.lng];
    if (
      lastBusMarkerLatLng &&
      distanceMeters(lastBusMarkerLatLng[0], lastBusMarkerLatLng[1], markerPos[0], markerPos[1]) < 250
    ) {
      return;
    }

    const busIcon = L.divIcon({
      className: "mode-icon",
      html: "🚌",
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });

    L.marker(markerPos, { icon: busIcon })
      .addTo(overlayLayer)
      .bindPopup(
        `<strong>대중교통 정차 추정</strong><br>${formatDate(stop.timestamp)}`,
      );

    lastBusMarkerLatLng = markerPos;
  });
}

function renderStayList() {
  const stayList = document.getElementById("stayList");
  const emptyStay = document.getElementById("emptyStay");

  stayList.innerHTML = "";

  if (currentStaySegments.length === 0) {
    emptyStay.hidden = false;
    return;
  }

  emptyStay.hidden = true;

  currentStaySegments.forEach((segment) => {
    const bucket = durationBucket(segment.durationMinutes);
    const locationText =
      segment.locationName ||
      `${segment.centerLat.toFixed(5)}, ${segment.centerLng.toFixed(5)} (위치 확인중)`;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${locationText} | ${formatDate(segment.start)} ~ ${formatDate(segment.end)} (${segment.durationMinutes}분, ${bucket.label})`;
    button.addEventListener("click", () => {
      map.setView([segment.centerLat, segment.centerLng], 17, {
        animate: true,
      });
    });

    li.appendChild(button);
    stayList.appendChild(li);
  });
}

async function hydrateStayLocations() {
  const targetRef = currentStaySegments;

  for (let i = 0; i < targetRef.length; i += 1) {
    const segment = targetRef[i];
    if (segment.locationName) {
      continue;
    }

    const key = `${segment.centerLat.toFixed(5)},${segment.centerLng.toFixed(5)}`;
    if (stayLocationCache.has(key)) {
      segment.locationName = stayLocationCache.get(key);
      continue;
    }

    const place = await reverseGeocodePoint(segment.centerLat, segment.centerLng);
    const normalized =
      place || `${segment.centerLat.toFixed(5)}, ${segment.centerLng.toFixed(5)} (주소 미확인)`;

    stayLocationCache.set(key, normalized);
    if (targetRef !== currentStaySegments) {
      return;
    }
    segment.locationName = normalized;
    renderStayList();
  }
}

async function reverseGeocodePoint(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}` +
    `&lon=${lng}&zoom=18&addressdetails=1`;

  try {
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "ko,en;q=0.7",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    await delay(1100);
    return formatReverseAddress(data);
  } catch (_error) {
    return null;
  }
}

function formatReverseAddress(data) {
  if (!data || !data.address) {
    return null;
  }

  const a = data.address;
  const building =
    a.building || a.amenity || a.tourism || a.shop || a.office || a.leisure || "";
  const road = a.road || a.pedestrian || a.footway || "";
  const number = a.house_number || "";
  const village = a.suburb || a.neighbourhood || a.quarter || "";

  if (building && road && number) {
    return `${building} (${road} ${number})`;
  }
  if (building && village) {
    return `${building} (${village})`;
  }
  if (road && number) {
    return `${road} ${number}`;
  }
  if (road) {
    return road;
  }
  if (village) {
    return village;
  }

  if (data.display_name) {
    return data.display_name.split(",").slice(0, 2).join(",").trim();
  }

  return null;
}

function bindInputActions() {
  const applyBtn = document.getElementById("applySmsBtn");
  const sampleBtn = document.getElementById("loadSampleBtn");

  applyBtn.addEventListener("click", async () => {
    const parseTextNode = document.getElementById("parseResult");
    const raw = document.getElementById("smsInput").value;

    applyBtn.disabled = true;
    parseTextNode.textContent = "분석 중...";

    try {
      const parseResult = await parseSmsText(raw);

      if (parseResult.errors.length > 0) {
        parseTextNode.textContent = `오류: ${parseResult.errors[0]}`;
        return;
      }

      currentPings = parseResult.pings;
      currentStaySegments = detectStaySegments(currentPings, STAY_DETECT_OPTIONS);

      await renderTrack();
      renderStayList();

      parseTextNode.textContent = `반영 완료: ${currentPings.length}개 위치, 체류 ${currentStaySegments.length}개`;
    } catch (error) {
      parseTextNode.textContent = `오류: ${error.message || "입력 처리 중 문제가 발생했습니다."}`;
    } finally {
      applyBtn.disabled = false;
    }
  });

  sampleBtn.addEventListener("click", () => {
    setDefaultInputText();
    document.getElementById("parseResult").textContent = "샘플 텍스트를 입력칸에 채웠습니다.";
  });
}

async function buildRoadAwarePath(pings) {
  const waypoints = extractRouteWaypoints(pings);
  if (waypoints.length < 2) {
    return [];
  }

  const combined = [];

  // OSRM 요청 길이 제한 완화를 위해 20개씩 끊어서 요청
  for (let i = 0; i < waypoints.length - 1; i += 19) {
    const chunk = waypoints.slice(i, Math.min(i + 20, waypoints.length));
    if (chunk.length < 2) {
      continue;
    }

    const routedChunk = await requestRoadRoute(chunk);
    const normalizedChunk =
      routedChunk && routedChunk.length >= 2
        ? routedChunk
        : chunk.map((p) => [p.lat, p.lng]);

    if (combined.length > 0 && normalizedChunk.length > 0) {
      normalizedChunk.shift();
    }
    combined.push(...normalizedChunk);
  }

  return combined;
}

function extractRouteWaypoints(pings) {
  if (!Array.isArray(pings) || pings.length === 0) {
    return [];
  }

  const result = [pings[0]];
  let anchor = pings[0];

  for (let i = 1; i < pings.length; i += 1) {
    const current = pings[i];
    const dist = distanceMeters(anchor.lat, anchor.lng, current.lat, current.lng);
    const mins = (current.timestamp - anchor.timestamp) / 60000;

    // 체류 구간은 과밀 점을 줄이고, 이동이 생기면 다음 앵커로 추가
    if (dist >= 180 || mins >= 45) {
      result.push(current);
      anchor = current;
    }
  }

  const last = pings[pings.length - 1];
  const lastInResult = result[result.length - 1];
  if (lastInResult.timestamp.getTime() !== last.timestamp.getTime()) {
    result.push(last);
  }

  return result;
}

async function requestRoadRoute(points) {
  const coordText = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordText}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (!data.routes || !data.routes[0] || !data.routes[0].geometry) {
      return null;
    }

    return data.routes[0].geometry.coordinates.map((coord) => [coord[1], coord[0]]);
  } catch (_error) {
    return null;
  }
}

function setDefaultInputText() {
  const lines = [
    "[Web발신][9]72740801[0409-08:00]세종특별자치시 어진동 610",
    "[Web발신][9]72740801[0409-08:12]세종특별자치시 어진동 610",
    "[Web발신][11]72740801[0409-08:18]세종특별자치시 나성동 361-50",
    "[Web발신][11]72740801[0409-09:05]세종특별자치시 나성동 361-50",
    "[Web발신][14]72740801[0409-09:15]세종특별자치시 어진동 620",
    "[Web발신][14]72740801[0409-11:20]세종특별자치시 어진동 620",
    "[Web발신][22]72740801[0409-11:35]세종특별자치시 대평동 62-3",
    "[Web발신][22]72740801[0409-19:50]세종특별자치시 대평동 62-3",
  ];

  document.getElementById("smsInput").value = lines.join("\n");
}

async function parseSmsText(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const pings = [];
  const errors = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const parsed = parseOneLine(line);

    if (!parsed) {
      errors.push(`${i + 1}번째 줄 형식을 확인하세요: ${line}`);
      continue;
    }

    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) {
      pings.push(parsed);
      continue;
    }

    const geo = await geocodeAddress(parsed.address);
    if (!geo) {
      errors.push(`${i + 1}번째 줄 주소 좌표 변환 실패: ${parsed.address}`);
      continue;
    }

    pings.push({
      ...parsed,
      lat: geo.lat,
      lng: geo.lng,
    });
  }

  pings.sort((a, b) => a.timestamp - b.timestamp);

  if (pings.length < 2 && errors.length === 0) {
    errors.push("최소 2줄 이상의 위치 데이터가 필요합니다.");
  }

  return { pings, errors };
}

function parseOneLine(line) {
  const csvParts = line.split(",");
  if (csvParts.length >= 3) {
    const timestamp = parseTimestamp(csvParts[0].trim());
    const lat = Number(csvParts[1].trim());
    const lng = Number(csvParts[2].trim());

    if (timestamp && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { timestamp, lat, lng };
    }
  }

  const carrierRegex = /^\[(?:Web발신|웹발신)\]\[(\d+)\](\d+)\[(\d{2})(\d{2})-(\d{2}):(\d{2})\](.+)$/;
  const m = line.match(carrierRegex);

  if (m) {
    const now = new Date();
    const year = now.getFullYear();
    const month = Number(m[3]);
    const day = Number(m[4]);
    const hour = Number(m[5]);
    const minute = Number(m[6]);
    const address = m[7].trim();

    const timestamp = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);

    if (Number.isNaN(timestamp.getTime()) || !address) {
      return null;
    }

    return {
      timestamp,
      address,
      cellId: m[1],
      phone: m[2],
    };
  }

  const coords = line.match(/-?\d+\.\d+/g);
  const tsMatch = line.match(/\d{4}[-/.]\d{2}[-/.]\d{2}\s+\d{2}:\d{2}/);
  if (coords && coords.length >= 2 && tsMatch) {
    const timestamp = parseTimestamp(tsMatch[0]);
    const lat = Number(coords[0]);
    const lng = Number(coords[1]);
    if (timestamp && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { timestamp, lat, lng };
    }
  }

  return null;
}

async function geocodeAddress(address) {
  if (geocodeCache.has(address)) {
    return geocodeCache.get(address);
  }

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&q=${encodeURIComponent(address)}`;
  const response = await fetch(url, {
    headers: {
      "Accept-Language": "ko,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error("주소 좌표 변환 서비스에 연결하지 못했습니다.");
  }

  const result = await response.json();

  if (!Array.isArray(result) || result.length === 0) {
    geocodeCache.set(address, null);
    await delay(1100);
    return null;
  }

  const value = {
    lat: Number(result[0].lat),
    lng: Number(result[0].lon),
  };

  geocodeCache.set(address, value);
  await delay(1100);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function detectStaySegments(pings, options) {
  if (!Array.isArray(pings) || pings.length < 2) {
    return [];
  }

  const sorted = [...pings].sort((a, b) => a.timestamp - b.timestamp);
  const segments = [];
  let cluster = [sorted[0]];
  let centroid = { lat: sorted[0].lat, lng: sorted[0].lng };

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const distance = distanceMeters(centroid.lat, centroid.lng, current.lat, current.lng);

    if (distance <= options.radiusMeters) {
      cluster.push(current);
      centroid = calcCentroid(cluster);
      continue;
    }

    appendStayIfValid(cluster, options.minStayMinutes, segments);
    cluster = [current];
    centroid = { lat: current.lat, lng: current.lng };
  }

  appendStayIfValid(cluster, options.minStayMinutes, segments);
  return segments;
}

function buildMovementAnalytics(pings) {
  if (!Array.isArray(pings) || pings.length < 2) {
    return { segments: [], busStops: [] };
  }

  const segments = [];
  const busStops = [];
  const busSegmentIndexes = new Set();

  for (let i = 1; i < pings.length; i += 1) {
    const from = pings[i - 1];
    const to = pings[i];
    const seconds = Math.max(1, (to.timestamp - from.timestamp) / 1000);
    const distMeters = distanceMeters(from.lat, from.lng, to.lat, to.lng);
    const speedKmh = (distMeters / seconds) * 3.6;

    segments.push({
      from,
      to,
      speedKmh,
      distMeters,
    });
  }

  // 정차 전후가 중속(버스 가능 속도)이면 버스 정류장 정차로 간주
  for (let i = 1; i < segments.length - 1; i += 1) {
    const prev = segments[i - 1].speedKmh;
    const curr = segments[i].speedKmh;
    const next = segments[i + 1].speedKmh;

    if (curr < 2 && prev >= 10 && prev < 35 && next >= 10 && next < 35) {
      busStops.push({
        lat: pings[i].lat,
        lng: pings[i].lng,
        timestamp: pings[i].timestamp,
      });

      for (let j = Math.max(0, i - 2); j <= Math.min(segments.length - 1, i + 2); j += 1) {
        if (segments[j].speedKmh >= 8 && segments[j].speedKmh < 35) {
          busSegmentIndexes.add(j);
        }
      }
    }
  }

  segments.forEach((segment, idx) => {
    segment.mode = classifyMode(segment.speedKmh, busSegmentIndexes.has(idx));
  });

  return { segments, busStops };
}

function calcCentroid(points) {
  const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const avgLng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat: avgLat, lng: avgLng };
}

function appendStayIfValid(cluster, minStayMinutes, output) {
  if (cluster.length < 2) {
    return;
  }

  const start = cluster[0].timestamp;
  const end = cluster[cluster.length - 1].timestamp;
  const durationMinutes = Math.floor((end - start) / 60000);

  if (durationMinutes < minStayMinutes) {
    return;
  }

  const avgLat = cluster.reduce((sum, p) => sum + p.lat, 0) / cluster.length;
  const avgLng = cluster.reduce((sum, p) => sum + p.lng, 0) / cluster.length;

  output.push({
    start,
    end,
    durationMinutes,
    centerLat: avgLat,
    centerLng: avgLng,
  });
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function degToRad(value) {
  return value * (Math.PI / 180);
}

function formatDate(dateValue) {
  const y = dateValue.getFullYear();
  const m = String(dateValue.getMonth() + 1).padStart(2, "0");
  const d = String(dateValue.getDate()).padStart(2, "0");
  const hh = String(dateValue.getHours()).padStart(2, "0");
  const mm = String(dateValue.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function formatDateOrBlank(dateValue) {
  if (!dateValue) {
    return "";
  }

  return formatDate(dateValue);
}

function durationBucket(durationMinutes) {
  if (durationMinutes < 30) {
    return { label: "30분 미만", radius: 7 };
  }

  if (durationMinutes < 60) {
    return { label: "1시간 미만", radius: 10 };
  }

  if (durationMinutes < 180) {
    return { label: "3시간 미만", radius: 14 };
  }

  if (durationMinutes < 300) {
    return { label: "5시간 미만", radius: 18 };
  }

  if (durationMinutes < 480) {
    return { label: "5시간 이상 8시간 미만", radius: 21 };
  }

  return { label: "8시간 이상", radius: 25 };
}

function speedColor(mode) {
  if (mode === "idle") {
    return "#9ca3af";
  }

  if (mode === "walk") {
    return "#f59e0b";
  }

  if (mode === "bus") {
    return "#16a34a";
  }

  if (mode === "car") {
    return "#2563eb";
  }

  return "#64748b";
}

function classifyMode(speedKmh, isBusPattern) {
  if (speedKmh >= 30) {
    return "car";
  }

  if (isBusPattern || (speedKmh >= 10 && speedKmh < 35)) {
    return isBusPattern ? "bus" : "transit";
  }

  if (speedKmh >= 4) {
    return "walk";
  }

  return "idle";
}

function modeLabel(mode) {
  if (mode === "car") {
    return "차량 이동 추정";
  }
  if (mode === "bus") {
    return "대중교통 추정";
  }
  if (mode === "walk") {
    return "도보 추정";
  }
  if (mode === "idle") {
    return "정차/체류";
  }
  return "이동";
}

function markerStyleByDuration(durationMinutes) {
  if (durationMinutes < 30) {
    return { fill: "#fca5a5", stroke: "#ef4444", opacity: 0.75 };
  }

  if (durationMinutes < 60) {
    return { fill: "#fb7185", stroke: "#e11d48", opacity: 0.8 };
  }

  if (durationMinutes < 180) {
    return { fill: "#f43f5e", stroke: "#be123c", opacity: 0.85 };
  }

  if (durationMinutes < 300) {
    return { fill: "#dc2626", stroke: "#991b1b", opacity: 0.9 };
  }

  if (durationMinutes < 480) {
    return { fill: "#b91c1c", stroke: "#7f1d1d", opacity: 0.92 };
  }

  return { fill: "#7f1d1d", stroke: "#450a0a", opacity: 0.96 };
}

function buildSamplePings() {
  const startTime = new Date("2026-04-09T08:00:00+09:00");
  const pings = [];
  let currentTime = new Date(startTime);

  function pushStay(centerLat, centerLng, minutes) {
    for (let i = 0; i < minutes; i += 1) {
      const latJitter = ((i % 4) - 1.5) * 0.00003;
      const lngJitter = ((i % 5) - 2) * 0.00003;

      pings.push({
        timestamp: new Date(currentTime),
        lat: centerLat + latJitter,
        lng: centerLng + lngJitter,
      });

      currentTime = new Date(currentTime.getTime() + 60000);
    }
  }

  function pushMove(fromLat, fromLng, toLat, toLng, minutes) {
    for (let i = 1; i <= minutes; i += 1) {
      const ratio = i / minutes;
      pings.push({
        timestamp: new Date(currentTime),
        lat: fromLat + (toLat - fromLat) * ratio,
        lng: fromLng + (toLng - fromLng) * ratio,
      });

      currentTime = new Date(currentTime.getTime() + 60000);
    }
  }

  function pushMoveAlong(waypoints, minutesPerLeg) {
    for (let i = 1; i < waypoints.length; i += 1) {
      const from = waypoints[i - 1];
      const to = waypoints[i];
      const legMinutes = Array.isArray(minutesPerLeg) ? minutesPerLeg[i - 1] : minutesPerLeg;
      pushMove(from[0], from[1], to[0], to[1], legMinutes);
    }
  }

  // 체류 5지점(10분 이상) + 도로축 이동
  // A: 정부세종청사 인근
  pushStay(36.50415, 127.26198, 22); // 30분 미만
  pushMoveAlong(
    [
      [36.50415, 127.26198],
      [36.50395, 127.26205],
      [36.50360, 127.26220],
      [36.50310, 127.26255],
      [36.50255, 127.26295],
      [36.50195, 127.26325],
    ],
    [3, 3, 4, 5], // 도보 수준
  );

  // B: 나성동 인근
  pushStay(36.50195, 127.26325, 48); // 1시간 미만

  // 버스/대중교통 추정 구간 + 정차 패턴
  pushMoveAlong(
    [
      [36.50195, 127.26325],
      [36.50095, 127.26475],
      [36.50000, 127.26620],
      [36.49920, 127.26760],
    ],
    [1, 1, 1],
  );
  pushStay(36.50095, 127.26475, 2); // 버스 정차
  pushMoveAlong(
    [
      [36.50095, 127.26475],
      [36.50000, 127.26620],
      [36.49920, 127.26760],
    ],
    [2, 2],
  );
  pushStay(36.50000, 127.26620, 1); // 버스 정차

  // C: 세종 중심권 남측
  pushStay(36.49920, 127.26760, 130); // 3시간 미만

  // 차량 고속 이동 추정 구간
  pushMoveAlong(
    [
      [36.49920, 127.26760],
      [36.49870, 127.27520],
      [36.49800, 127.28280],
      [36.49730, 127.29040],
    ],
    [1, 1, 1],
  );

  // D: 도담/어진 축 동측
  pushStay(36.49730, 127.29040, 245); // 5시간 미만
  pushMoveAlong(
    [
      [36.49730, 127.29040],
      [36.49680, 127.29095],
      [36.49620, 127.29145],
      [36.49560, 127.29190],
    ],
    [3, 3, 4],
  );

  // E: 남측 생활권
  pushStay(36.49560, 127.29190, 500); // 8시간 이상

  return pings;
}
