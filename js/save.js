/* Incident generation plus save/load/new-game persistence. */
function destinationPoint(origin, distanceKm, bearingDeg) {
  const R = 6371;
  const d = distanceKm / R;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = origin.lat * Math.PI / 180;
  const lon1 = origin.lng * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );

  return L.latLng(lat2 * 180/Math.PI, lon2 * 180/Math.PI);
}

async function pointLooksSuitableForIncident(point) {
  // First reject points that are nowhere near a drivable road. This catches
  // most ocean/offshore candidates without requiring heavy map data.
  try {
    const nearestUrl =
      `https://router.project-osrm.org/nearest/v1/driving/${point.lng},${point.lat}?number=1`;
    const nearestRes = await fetchWithTimeout(nearestUrl, 2800);
    if (!nearestRes.ok) return false;
    const nearestData = await nearestRes.json();
    const distanceToRoad = Number(nearestData?.waypoints?.[0]?.distance);
    if (!Number.isFinite(distanceToRoad) || distanceToRoad > 1800) return false;
  } catch (err) {
    // If OSRM is temporarily unavailable, let reverse geocoding make the call.
  }

  try {
    const reverseUrl =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lng}&zoom=14&addressdetails=1`;
    const res = await fetchWithTimeout(reverseUrl, 3500);
    if (!res.ok) return false;
    const data = await res.json();

    if (data?.address?.country_code && data.address.country_code !== 'au') return false;

    const badTypes = new Set(['sea','ocean','bay','strait','water','reservoir']);
    const type = String(data?.type || '').toLowerCase();
    if (badTypes.has(type)) return false;

    // A valid Australian reverse-geocode result is considered land/local water-edge safe.
    return Boolean(data && (data.address || data.display_name));
  } catch (err) {
    // Fallback: OSRM already accepted the point as reasonably close to a road.
    return true;
  }
}

async function randomIncidentNearStation() {
  const eligibleStations = state.stations.filter(s => !['DBCA','AIRBASE'].includes(s.type));
  if (!eligibleStations.length) return null;

  const maxRadius = Number(els.incidentRadius.value || 15);
  const minRadius = Math.min(1.5, maxRadius * 0.15);

  for (let attempt = 0; attempt < 12; attempt++) {
    const station = eligibleStations[Math.floor(Math.random() * eligibleStations.length)];
    const distance = minRadius + Math.sqrt(Math.random()) * (maxRadius - minRadius);
    const bearing = Math.random() * 360;
    const latlng = destinationPoint(station.latlng, distance, bearing);

    if (await pointLooksSuitableForIncident(latlng)) {
      return {station, latlng, distance};
    }
  }

  return null;
}


const SAVE_KEY = 'bushfire-command-v0.5.1-save';

function serializeGame() {
  return {
    version:'0.5.1',
    minutes:state.minutes,
    speed:state.speed,
    paused:state.paused,
    autoCalls:state.autoCalls,
    windSimulation:state.windSimulation,
    simulatedWindBearing:state.simulatedWindBearing,
    simulatedWindSpeed:state.simulatedWindSpeed,
    simulatedGust:state.simulatedGust,
    windTargetBearing:state.windTargetBearing,
    windTargetSpeed:state.windTargetSpeed,
    fuelLoad:state.fuelLoad,
    fuelTarget:state.fuelTarget,
    fuelChangeTimer:state.fuelChangeTimer,
    completedJobs:state.completedJobs || [],
    nextStation:state.nextStation,
    nextFire:state.nextFire,
    nextSpecialId:state.nextSpecialId,
    stations:state.stations.map(s => ({
      id:s.id,
      name:s.name,
      type:s.type || 'BUSHFIRE',
      systemKey:s.systemKey || null,
      hiddenSystemBase:!!s.hiddenSystemBase,
      lat:s.latlng.lat,
      lng:s.latlng.lng,
      appliances:s.appliances.map(a => ({
        id:a.id,
        code:a.code,
        callsign:a.callsign,
        customCallsign:a.customCallsign || null,
        water:a.water,
        drive:a.drive,
        role:a.role,
        attack:a.attack,
        status:a.status === 'Available' ? 'Available' : 'Available',
        assignment:null,
        eta:0,
        task:'None',
        currentWater:a.currentWater,
        maxWater:a.maxWater
      }))
    })),
    icps:state.icps.map(i => ({
      id:i.id,
      lat:i.latlng.lat,
      lng:i.latlng.lng,
      fireId:i.fireId || null
    })),
    warnings:state.warnings.filter(w => w.active).map(w => ({
      id:w.id,
      level:w.level,
      message:w.message,
      issuedAt:w.issuedAt,
      history:w.history,
      latlngs:w.poly.getLatLngs()[0].map(p => ({lat:p.lat,lng:p.lng}))
    }))
  };
}


function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function makeSaveExportFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `Bushfire-Command-Save-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}

function exportSaveFile() {
  try {
    const raw = JSON.stringify(serializeGame(), null, 2);
    downloadTextFile(makeSaveExportFilename(), raw);
    log('Save exported as JSON. This can be imported into the Electron app or browser build.');
  } catch (e) {
    console.error(e);
    log('Could not export save file.');
  }
}

async function importLegacySaveFile(file) {
  if (!file) return;

  let raw = '';
  try {
    raw = await file.text();
  } catch (e) {
    console.error(e);
    log('Could not read the selected save file.');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log('Selected file is not valid JSON.');
    return;
  }

  if (!parsed || typeof parsed !== 'object' || !('stations' in parsed) || !('fires' in parsed)) {
    log('Selected file does not look like an Incident Command save.');
    return;
  }

  // Write the imported raw save into the Electron/native slot when available,
  // otherwise mirror the browser save slot and load it normally.
  try {
    if (window.bushfireDesktop?.saveGame) {
      const result = await window.bushfireDesktop.saveGame(raw);
      if (!result?.ok) throw new Error(result?.error || 'Desktop import failed');
    } else {
      localStorage.setItem(SAVE_KEY, raw);
    }
  } catch (e) {
    console.error(e);
    log('Import failed while saving the legacy file.');
    return;
  }

  log('Legacy/browser save imported. Loading now...');
  await loadGame();
}

async function saveGame() {
  const raw = JSON.stringify(serializeGame());

  if (window.bushfireDesktop?.saveGame) {
    try {
      const result = await window.bushfireDesktop.saveGame(raw);
      if (result?.ok) {
        log('Game saved to desktop save file.');
        return;
      }
      throw new Error(result?.error || 'desktop save failed');
    } catch (e) {
      console.error('Desktop save failed:', e);
      log('Desktop save failed; falling back to browser storage.');
    }
  }

  try {
    localStorage.setItem(SAVE_KEY, raw);
    log('Game saved locally.');
  } catch (e) {
    log('Save failed: storage unavailable.');
  }
}

function clearRuntimeLayers() {
  state.stations.forEach(s => { if (s.marker) map.removeLayer(s.marker); });
  state.icps.forEach(i => { if (i.marker) map.removeLayer(i.marker); });
  state.fires.forEach(f => {
    if (f.marker) map.removeLayer(f.marker);
    if (f.perimeter) map.removeLayer(f.perimeter);
    if (f.burn) map.removeLayer(f.burn);
    if (f.containmentLine) map.removeLayer(f.containmentLine);
    (f.burnHistoryLayers || []).forEach(layer => {
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });
    (f.assignments || []).forEach(a => {
      if (a.marker) map.removeLayer(a.marker);
      if (a.routeLine) map.removeLayer(a.routeLine);
      if (a.firegroundLine) map.removeLayer(a.firegroundLine);
    });
  });
  state.specialResources.forEach(r => { if (r.marker) map.removeLayer(r.marker); });
  (state.returningAppliances || []).forEach(r => {
    if (r.marker && map.hasLayer(r.marker)) map.removeLayer(r.marker);
    if (r.routeLine && map.hasLayer(r.routeLine)) map.removeLayer(r.routeLine);
  });
  state.warnings.forEach(w => { if (w.poly && map.hasLayer(w.poly)) map.removeLayer(w.poly); });
}

async function loadGame() {
  let raw = null;
  let loadedFromDesktop = false;

  if (window.bushfireDesktop?.loadGame) {
    try {
      const result = await window.bushfireDesktop.loadGame();
      if (result?.ok && result.raw) {
        raw = result.raw;
        loadedFromDesktop = true;
      }
    } catch (e) {
      console.error('Desktop load failed:', e);
    }
  }

  // Browser/localStorage fallback also provides a one-time migration path
  // from the old HTML build into the Electron save file.
  if (!raw) {
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (e) {}
  }

  if (!raw) {
    log('No saved game found.');
    return;
  }

  if (!loadedFromDesktop && window.bushfireDesktop?.saveGame) {
    try {
      await window.bushfireDesktop.saveGame(raw);
      log('Legacy browser save migrated to the desktop save file.');
    } catch (e) {
      console.warn('Legacy save migration failed:', e);
    }
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log('Saved game is unreadable.');
    return;
  }

  clearRuntimeLayers();

  state.minutes = Number(data.minutes) || 720;
  state.speed = Number(data.speed) || 1;
  state.paused = !!data.paused;
  state.autoCalls = !!data.autoCalls;
  state.windSimulation = true;
  state.simulatedWindBearing = Number.isFinite(Number(data.simulatedWindBearing))
    ? Number(data.simulatedWindBearing)
    : Math.random() * 360;
  state.simulatedWindSpeed = Number.isFinite(Number(data.simulatedWindSpeed))
    ? Number(data.simulatedWindSpeed)
    : 6 + Math.random() * 34;
  state.simulatedGust = Number(data.simulatedGust ?? state.simulatedWindSpeed + 4);
  state.windTargetBearing = Number(data.windTargetBearing ?? state.simulatedWindBearing);
  state.windTargetSpeed = Number(data.windTargetSpeed ?? state.simulatedWindSpeed);
  state.fuelLoad = Number.isFinite(Number(data.fuelLoad)) ? Number(data.fuelLoad) : 1;
  state.fuelTarget = Number.isFinite(Number(data.fuelTarget)) ? Number(data.fuelTarget) : state.fuelLoad;
  state.fuelChangeTimer = Number.isFinite(Number(data.fuelChangeTimer)) ? Number(data.fuelChangeTimer) : 60 + Math.random() * 120;
  state.completedJobs = Array.isArray(data.completedJobs) ? data.completedJobs : [];
  state.nextStation = Number(data.nextStation) || 1;
  state.nextFire = Number(data.nextFire) || 1;
  state.nextSpecialId = Number(data.nextSpecialId) || 1;
  state.stations = [];
  state.icps = [];
  state.fires = [];
  state.specialResources = [];
  state.returningAppliances = [];
  state.warnings = [];
  state.polygons = [];
  state.selectedIncidentId = null;

  (data.stations || []).forEach(s => {
    const latlng = L.latLng(s.lat,s.lng);
    const isHiddenRescueBase =
      !!s.hiddenSystemBase ||
      String(s.systemKey || '').startsWith('system-rescue-') ||
      s.name === 'Jandakot Rescue Helicopter Base' ||
      s.name === 'Bunbury Rescue Helicopter Base';

    const appliances = (s.appliances || []).map(a => {
      const maxWater = Number(a.maxWater ?? a.water ?? 0) || 0;
      return {
        ...a,
        maxWater,
        currentWater:maxWater,
        status:'Available',
        assignment:null,
        eta:0,
        task:'None'
      };
    });

    let marker = null;
    if (!isHiddenRescueBase) {
      marker = L.marker(latlng, {icon:makeIcon(s.name, stationColor(s.type || 'BUSHFIRE'))}).addTo(map);
      marker.bindPopup(
        `<b>${s.name}</b><br>` +
        (appliances.length
          ? appliances.map(a => `${a.callsign} — ${a.maxWater.toLocaleString()} L ${a.role}`).join('<br>')
          : 'No appliances assigned')
      );
    }

    state.stations.push({
      id:s.id,
      name:s.name,
      type:s.type || 'BUSHFIRE',
      systemKey:s.systemKey || null,
      hiddenSystemBase:isHiddenRescueBase,
      latlng,
      marker,
      appliances
    });
  });

  ensureRescueHelicopterBases();

  (data.icps || []).forEach(i => {
    const latlng = L.latLng(i.lat,i.lng);
    const marker = L.marker(latlng, {icon:makeIcon(`ICP ${i.id}`,'#34495e')}).addTo(map);
    marker.bindPopup(`<b>Incident Control Point ${i.id}</b>`);
    state.icps.push({id:i.id,latlng,marker,fireId:i.fireId || null});
  });

  (data.warnings || []).forEach(w => {
    const latlngs = w.latlngs.map(p => [p.lat,p.lng]);
    const poly = L.polygon(latlngs, warningStyle(w.level)).addTo(map);
    poly.bindPopup(`<b>${warningLabel(w.level)}</b><br>${w.message}<br>Issued ${w.issuedAt}`);
    const restored = {...w, poly, active:true};
    state.warnings.push(restored);
    state.polygons.push({level:w.level, poly});
  });

  els.speedSel.value = String(state.speed);
  els.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  els.autoCallsBtn.textContent = `Auto Calls: ${state.autoCalls ? 'ON' : 'OFF'}`;
  updateWindUI();

  updateClock();
  if (els.completedJobsCount) els.completedJobsCount.textContent = (state.completedJobs || []).length;
  renderStations();
  renderWarnings();
  renderIncidents();

  const visibleStations = state.stations.filter(s => !s.hiddenSystemBase);
  if (visibleStations.length) {
    const bounds = L.latLngBounds(visibleStations.map(s => s.latlng));
    map.fitBounds(bounds.pad(0.25), {maxZoom:13});
  }

  log('Saved game loaded.');
}

async function newGame() {
  clearRuntimeLayers();

  if (window.bushfireDesktop?.deleteSave) {
    try {
      await window.bushfireDesktop.deleteSave();
    } catch (e) {
      console.warn('Desktop save deletion failed:', e);
    }
  }

  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  state.stations = [];
  state.icps = [];
  state.fires = [];
  state.specialResources = [];
  state.returningAppliances = [];
  state.completedJobs = [];
  if (els.completedJobsCount) els.completedJobsCount.textContent = '0';
  state.warnings = [];
  state.polygons = [];
  state.nextStation = 1;
  state.nextFire = 1;
  state.nextSpecialId = 1;
  state.selectedIncidentId = null;
  state.minutes = 720;
  state.autoCalls = false;
  state.windSimulation = true;
  els.autoCallsBtn.textContent = 'Auto Calls: OFF';
  randomizeWind();
  randomizeFuelLoad();
  ensureRescueHelicopterBases();
  renderStations();
  renderWarnings();
  renderIncidents();
  updateClock();
  log('New game started and local save cleared.');
}
