/* Station, fleet and appliance-management logic. */
function refreshApplianceChoicesForStationType() {
  const type = els.modalStationType.value || 'BUSHFIRE';
  document.querySelectorAll('.applianceChoice').forEach(input => {
    const spec = APPLIANCE_CATALOGUE[input.value];
    const row = input.closest('.check-item');
    const allowed = !spec || !Array.isArray(spec.services) || spec.services.includes(type);
    if (row) row.style.display = allowed ? '' : 'none';
    if (!allowed) input.checked = false;
  });
}



function baseStationName(name) {
  return name.replace(/\s+(VBFB|BFB|VFRS|VFES|CFRS|FRS|WAPOL|SJA|SES|DBCA|AIRBASE)$/i,'');
}

function generatedApplianceCallsign(station, appliance) {
  const sameType = station.appliances.filter(x => x.code === appliance.code);
  const index = sameType.indexOf(appliance);
  const suffix = sameType.length > 1 ? ` ${index + 1}` : '';
  return `${baseStationName(station.name)} ${appliance.code}${suffix}`;
}

function refreshStationCallsigns(station) {
  station.appliances.forEach(a => {
    a.callsign = a.customCallsign || generatedApplianceCallsign(station, a);
  });
}

function renameAppliance(applianceId) {
  const found = allAppliances().find(x => x.appliance.id === applianceId);
  if (!found || !els.renameApplianceModal) return;

  const a = found.appliance;
  state.renamingApplianceId = applianceId;

  els.renameApplianceCurrent.textContent =
    `${a.callsign} • ${a.code} at ${found.station.name}`;
  els.renameApplianceInput.value = a.customCallsign || a.callsign;
  els.renameApplianceModal.classList.add('open');

  setTimeout(() => {
    els.renameApplianceInput.focus();
    els.renameApplianceInput.select();
  }, 20);
}

function closeRenameApplianceModal() {
  if (els.renameApplianceModal) {
    els.renameApplianceModal.classList.remove('open');
  }
  state.renamingApplianceId = null;
}

function saveRenamedAppliance() {
  const applianceId = state.renamingApplianceId;
  if (!applianceId) return;

  const found = allAppliances().find(x => x.appliance.id === applianceId);
  if (!found) {
    closeRenameApplianceModal();
    return;
  }

  const a = found.appliance;
  const value = String(els.renameApplianceInput?.value || '').trim();

  if (value) {
    a.customCallsign = value;
    a.callsign = value;
    log(`${a.code} at ${found.station.name} renamed to ${value}.`);
  } else {
    a.customCallsign = null;
    refreshStationCallsigns(found.station);
    log(`${a.code} at ${found.station.name} reset to its generated callsign.`);
  }

  refreshStationMarker(found.station);
  closeRenameApplianceModal();
  renderStations();
  renderIncidents();
}

function buildAppliances(stationName, codes) {
  return codes.map((code, idx) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${idx}`,
    code,
    callsign: `${baseStationName(stationName)} ${code}`,
    customCallsign:null,
    ...APPLIANCE_CATALOGUE[code],
    status: "Available",
    assignment: null,
    eta: 0,
    task: "None",
    currentWater: APPLIANCE_CATALOGUE[code].water || 0,
    maxWater: APPLIANCE_CATALOGUE[code].water || 0,
    attack: APPLIANCE_CATALOGUE[code].attack
  }));
}


function ensureRescueHelicopterBases() {
  const specs = [
    {
      key:'system-rescue-jandakot',
      name:'Jandakot Rescue Helicopter Base',
      lat:-32.096699,
      lng:115.882004,
      callsigns:['Rescue 651','Rescue 653']
    },
    {
      key:'system-rescue-bunbury',
      name:'Bunbury Rescue Helicopter Base',
      lat:-33.3783,
      lng:115.6765,
      callsigns:['Rescue 652']
    }
  ];

  const allowedCallsigns = new Set(specs.flatMap(spec => spec.callsigns));

  // Rescue helicopters are a fixed state fleet. Remove copies created
  // manually at normal/player airbases by older builds.
  state.stations.forEach(station => {
    if (!String(station.systemKey || '').startsWith('system-rescue-')) {
      station.appliances = station.appliances.filter(a => a.code !== 'Rescue Helicopter');
    }
  });

  specs.forEach(spec => {
    let station = state.stations.find(s =>
      s.systemKey === spec.key ||
      s.name === spec.name
    );

    if (!station) {
      const appliances = spec.callsigns.map(callsign => {
        const aircraft = buildAppliances(spec.name, ['Rescue Helicopter'])[0];
        aircraft.customCallsign = callsign;
        aircraft.callsign = callsign;
        return aircraft;
      });

      station = {
        id:state.nextStation++,
        name:spec.name,
        type:'AIRBASE',
        systemKey:spec.key,
        hiddenSystemBase:true,
        latlng:L.latLng(spec.lat, spec.lng),
        marker:null,
        appliances
      };
      state.stations.push(station);
    }

    station.name = spec.name;
    station.type = 'AIRBASE';
    station.systemKey = spec.key;
    station.hiddenSystemBase = true;
    station.latlng = L.latLng(spec.lat, spec.lng);

    // Older builds drew these like normal stations. Remove those markers.
    if (station.marker && map.hasLayer(station.marker)) {
      map.removeLayer(station.marker);
    }
    station.marker = null;

    const existing = new Map();
    station.appliances
      .filter(a => a.code === 'Rescue Helicopter')
      .forEach(a => existing.set(a.customCallsign || a.callsign, a));

    station.appliances = station.appliances.filter(a => a.code !== 'Rescue Helicopter');

    spec.callsigns.forEach(callsign => {
      let aircraft = existing.get(callsign);
      if (!aircraft) {
        aircraft = buildAppliances(spec.name, ['Rescue Helicopter'])[0];
      }
      aircraft.customCallsign = callsign;
      aircraft.callsign = callsign;
      station.appliances.push(aircraft);
    });
  });

  // Defensive final sweep: only 651, 652 and 653 may exist.
  state.stations.forEach(station => {
    station.appliances = station.appliances.filter(a =>
      a.code !== 'Rescue Helicopter' ||
      (
        String(station.systemKey || '').startsWith('system-rescue-') &&
        allowedCallsigns.has(a.customCallsign || a.callsign)
      )
    );
  });
}

function deleteStation(stationId) {
  const station = state.stations.find(s => s.id === stationId);
  if (!station || station.hiddenSystemBase) return;

  const returning = (state.returningAppliances || []).some(r => r.stationId === station.id);
  const committed = station.appliances.some(a => a.status !== 'Available' || a.assignment);

  if (committed || returning) {
    log(`${station.name} cannot be deleted while an appliance is committed or returning.`);
    return;
  }

  state.deletingStationId = stationId;
  els.deleteStationMessage.textContent =
    `Delete ${station.name} and every appliance assigned to it?`;
  els.deleteStationModal.classList.add('open');
}

function closeDeleteStationModal() {
  if (els.deleteStationModal) {
    els.deleteStationModal.classList.remove('open');
  }
  state.deletingStationId = null;
}

function confirmDeleteStation() {
  const stationId = state.deletingStationId;
  const station = state.stations.find(s => s.id === stationId);

  if (!station || station.hiddenSystemBase) {
    closeDeleteStationModal();
    return;
  }

  if (station.marker && map.hasLayer(station.marker)) {
    map.removeLayer(station.marker);
  }

  state.stations = state.stations.filter(s => s.id !== stationId);

  // Completely clear any editor state connected to the deleted station.
  // This prevents the next station modal from inheriting a stale edit target.
  state.editingStationId = null;
  state.pendingStationLocation = null;
  if (els.stationModal) els.stationModal.classList.remove('open');

  closeDeleteStationModal();

  // Keep generated IDs safely above every existing station ID.
  const highestStationId = state.stations.reduce(
    (maxId, s) => Math.max(maxId, Number(s.id) || 0),
    0
  );
  state.nextStation = Math.max(Number(state.nextStation) || 1, highestStationId + 1);

  log(`${station.name} deleted.`);
  renderStations();
  renderIncidents();
}

function openStationModal(latlng) {
  // Always start creation from a clean editor state.
  state.editingStationId = null;
  state.pendingStationLocation = latlng;

  els.stationModalTitle.textContent = 'Create Brigade / Station';
  els.saveStationModal.textContent = 'Create Station';

  els.modalStationName.disabled = false;
  els.modalStationName.readOnly = false;
  els.modalStationType.disabled = false;

  els.modalStationName.value = '';
  els.modalStationType.value = 'BUSHFIRE';
  refreshApplianceChoicesForStationType();
  document.querySelectorAll('.applianceChoice').forEach(c => c.checked = false);
  document.querySelectorAll('.applianceQty').forEach(q => q.value = 1);
  els.stationModal.classList.add('open');
  setTimeout(() => els.modalStationName.focus(), 20);
}

function openStationEditModal(stationId) {
  const station = state.stations.find(s => s.id === stationId);
  if (!station) return;

  state.editingStationId = stationId;
  state.pendingStationLocation = station.latlng;
  els.stationModalTitle.textContent = 'Edit Brigade / Station';
  els.saveStationModal.textContent = 'Save Changes';

  els.modalStationName.disabled = false;
  els.modalStationName.readOnly = false;
  els.modalStationType.disabled = false;

  els.modalStationName.value = station.name;
  els.modalStationType.value = station.type || 'BUSHFIRE';
  refreshApplianceChoicesForStationType();

  const codeCounts = {};
  station.appliances.forEach(a => {
    codeCounts[a.code] = (codeCounts[a.code] || 0) + 1;
  });

  document.querySelectorAll('.applianceChoice').forEach(c => {
    const count = codeCounts[c.value] || 0;
    c.checked = count > 0;
    const qty = c.closest('.check-item')?.querySelector('.applianceQty');
    if (qty) qty.value = Math.max(1, count || 1);
  });

  els.stationModal.classList.add('open');
  setTimeout(() => els.modalStationName.focus(), 20);
}

function closeStationModal() {
  els.stationModal.classList.remove('open');
  state.pendingStationLocation = null;
  state.editingStationId = null;
  els.stationModalTitle.textContent = 'Create Brigade / Station';
  els.saveStationModal.textContent = 'Create Station';
}


function refreshStationMarker(station) {
  if (!station.marker || station.hiddenSystemBase) return;
  station.marker.setIcon(makeIcon(station.name, stationColor(station.type || 'BUSHFIRE')));
  station.marker.bindPopup(
    `<b>${station.name}</b><br><span class="mini">${stationTypeLabel(station.type || 'BUSHFIRE')}</span><br>` +
    (station.appliances.length
      ? station.appliances.map(a => `${a.callsign} — ${a.maxWater.toLocaleString()} L ${a.role}`).join('<br>')
      : 'No appliances assigned')
  );
}

function updateStation(stationId, name, requestedCodes, type='BUSHFIRE') {
  const station = state.stations.find(s => s.id === stationId);
  if (!station) return;

  const desiredCounts = {};
  requestedCodes.forEach(code => {
    desiredCounts[code] = (desiredCounts[code] || 0) + 1;
  });

  const kept = [];
  const existingByCode = {};
  station.appliances.forEach(a => {
    if (!existingByCode[a.code]) existingByCode[a.code] = [];
    existingByCode[a.code].push(a);
  });

  const allCodes = new Set([
    ...Object.keys(existingByCode),
    ...Object.keys(desiredCounts)
  ]);

  allCodes.forEach(code => {
    const existing = existingByCode[code] || [];
    const desired = desiredCounts[code] || 0;

    const busy = existing.filter(a => a.status !== 'Available');
    const available = existing.filter(a => a.status === 'Available');

    // Busy appliances are always retained, even if the requested quantity is lower.
    kept.push(...busy);

    const stillNeeded = Math.max(0, desired - busy.length);
    kept.push(...available.slice(0, stillNeeded));

    const toAdd = Math.max(0, stillNeeded - available.length);
    if (toAdd > 0) {
      kept.push(...buildAppliances(name, Array(toAdd).fill(code)));
    }

    if (busy.length > desired) {
      log(`${station.name}: ${busy.length - desired} busy ${code} appliance(s) retained until available.`);
    }
  });

  station.name = name;
  station.type = type;
  station.appliances = kept;

  refreshStationCallsigns(station);

  refreshStationMarker(station);
  log(`${station.name} updated: ${station.appliances.length ? station.appliances.map(a => a.code).join(', ') : 'no appliances'}.`);
  renderStations();
  renderIncidents();
}

function addStation(latlng, name, applianceCodes, type='BUSHFIRE') {
  const id = state.nextStation++;
  const appliances = buildAppliances(name, applianceCodes);

  const tempStation = {name, appliances};
  refreshStationCallsigns(tempStation);

  const marker = L.marker(latlng, {icon:makeIcon(name, stationColor(type))}).addTo(map);
  marker.bindPopup(
    `<b>${name}</b><br>` +
    (appliances.length
      ? appliances.map(a => `${a.callsign} — ${a.water.toLocaleString()} L ${a.role}`).join('<br>')
      : 'No appliances assigned')
  );

  state.stations.push({id,name,type,latlng,marker,appliances});
  log(`${name} established as ${stationTypeLabel(type)}${appliances.length ? ` with ${appliances.map(a => a.code).join(', ')}` : ''}.`);
  renderStations();
}
