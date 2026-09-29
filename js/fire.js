/* Incident creation, ICPs, weather, fire geometry and fire-behaviour model. */
function addICP(latlng) {
  const id = state.icps.length + 1;

  let fire = state.fires.find(f => f.id === state.selectedIncidentId);
  if (!fire && state.fires.length) {
    fire = state.fires
      .map(f => ({f, d:haversineKm(latlng, f.ignition)}))
      .sort((a,b) => a.d - b.d)[0].f;
  }

  const marker = L.marker(latlng, {icon:makeIcon(`ICP ${id}`,'#34495e')}).addTo(map);
  marker.bindPopup(
    `<b>Incident Control Point ${id}</b>` +
    (fire ? `<br>Assigned to ${fire.name}` : '')
  );

  const icp = {id,latlng,marker,fireId:fire ? fire.id : null};
  state.icps.push(icp);

  if (fire) {
    fire.icpId = id;
    log(`Incident Control Point ${id} established for ${fire.name}. Responding appliances will stage there first.`);
    renderIncidents();
  } else {
    log(`Incident Control Point ${id} established.`);
  }
}

function offsetPoint(origin, northMeters, eastMeters) {
  const latRad = origin.lat * Math.PI / 180;
  return L.latLng(
    origin.lat + northMeters / 111320,
    origin.lng + eastMeters / (111320 * Math.cos(latRad))
  );
}

function fireEllipsePoints(center, alongMeters, crossMeters, bearingDeg, count=64) {
  const pts = [];
  const brng = bearingDeg * Math.PI / 180;

  for (let i=0; i<count; i++) {
    const th = i / count * Math.PI * 2;

    // Local fire coordinates:
    // along = direction of fire travel / wind
    // cross = left/right flank direction
    const along = alongMeters * Math.cos(th);
    const cross = crossMeters * Math.sin(th);

    // Convert a compass bearing (0=N, 90=E) into north/east offsets.
    const north = along * Math.cos(brng) - cross * Math.sin(brng);
    const east  = along * Math.sin(brng) + cross * Math.cos(brng);

    const p = offsetPoint(center, north, east);
    pts.push([p.lat, p.lng]);
  }
  return pts;
}


function bearingToDir(bearing) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const normalized = ((bearing % 360) + 360) % 360;
  return dirs[Math.round(normalized / 22.5) % 16];
}

function shortestBearingDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function dirToBearing(dir) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs.indexOf(dir) * 22.5;
}



function currentWindBearing() {
  return Number(state.simulatedWindBearing) || 0;
}

function currentWindSpeed() {
  return Math.max(0, Number(state.simulatedWindSpeed) || 0);
}

function currentFuelLoad() {
  return Math.max(0.55, Math.min(2.0, Number(state.fuelLoad) || 1));
}

function randomizeFuelLoad() {
  // Hidden dynamic fuel conditions. Think of this as the sim's current
  // vegetation dryness / available fuel rather than a player setting.
  const presets = [0.7, 1.0, 1.4, 1.9];
  state.fuelLoad = presets[Math.floor(Math.random() * presets.length)];
  state.fuelTarget = state.fuelLoad;
  state.fuelChangeTimer = 45 + Math.random() * 90;
  chooseNextFuelTarget();
}

function chooseNextFuelTarget() {
  const current = currentFuelLoad();
  // Usually drift one step; occasionally jump further after a long weather cycle.
  const presets = [0.7, 1.0, 1.4, 1.9];
  let nearest = presets.reduce((best, value) =>
    Math.abs(value - current) < Math.abs(best - current) ? value : best
  , presets[0]);
  let idx = presets.indexOf(nearest);
  const roll = Math.random();
  if (roll < 0.18) idx += Math.random() < .5 ? -2 : 2;
  else if (roll < 0.68) idx += Math.random() < .5 ? -1 : 1;
  idx = Math.max(0, Math.min(presets.length - 1, idx));

  state.fuelTarget = presets[idx];
  state.fuelChangeTimer = 60 + Math.random() * 120;
}

function updateFuelSimulation(dtMinutes) {
  state.fuelChangeTimer -= dtMinutes;
  if (state.fuelChangeTimer <= 0) {
    chooseNextFuelTarget();
  }

  const delta = state.fuelTarget - state.fuelLoad;
  if (Math.abs(delta) > 0.001) {
    const step = Math.sign(delta) * Math.min(Math.abs(delta), 0.004 * dtMinutes);
    state.fuelLoad = Math.max(0.55, Math.min(2.0, state.fuelLoad + step));
  }
}

function randomizeWind() {
  // Start each fresh session/game with genuinely variable conditions.
  // Bearing is unrestricted; sustained wind is kept in a gameplay-useful range.
  state.windSimulation = true;
  state.simulatedWindBearing = Math.random() * 360;
  state.simulatedWindSpeed = 6 + Math.random() * 34; // 6–40 km/h
  state.simulatedGust = Math.min(
    90,
    state.simulatedWindSpeed + 3 + Math.random() * 12
  );
  state.windTargetBearing = state.simulatedWindBearing;
  state.windTargetSpeed = state.simulatedWindSpeed;
  state.windTrend = 'steady';
  state.windChangeTimer = 2 + Math.random() * 8;
  state.windGustTimer = 1 + Math.random() * 4;
  chooseNextWindTarget();
  updateWindUI();
}

function currentWindDirectionLabel() {
  return bearingToDir(currentWindBearing());
}

function updateWindUI() {
  const dir = currentWindDirectionLabel();
  const speed = currentWindSpeed();
  const gust = Math.max(speed, Number(state.simulatedGust) || speed);
  if (els.weatherStatus) {
    els.weatherStatus.textContent =
      `Wind ${Math.round(speed)} km/h ${dir} • gust ${Math.round(gust)}`;
  }
}

function chooseNextWindTarget() {
  const baseBearing = Number(state.simulatedWindBearing) || 0;
  const baseSpeed = Math.max(0, Number(state.simulatedWindSpeed) || 0);

  // Most changes are small; occasionally the wind shifts enough to create a new head.
  const majorShift = Math.random() < 0.18;
  const bearingChange = majorShift
    ? (25 + Math.random() * 55) * (Math.random() < .5 ? -1 : 1)
    : (Math.random() * 24 - 12);

  state.windTargetBearing = (baseBearing + bearingChange + 360) % 360;

  const speedChange = majorShift
    ? (Math.random() * 16 - 5)
    : (Math.random() * 8 - 4);

  state.windTargetSpeed = Math.max(0, Math.min(70, baseSpeed + speedChange));
  state.windChangeTimer = 20 + Math.random() * 40;

  const delta = shortestBearingDelta(state.simulatedWindBearing, state.windTargetBearing);
  if (Math.abs(delta) < 5 && Math.abs(state.windTargetSpeed - state.simulatedWindSpeed) < 2) {
    state.windTrend = 'steady';
  } else if (Math.abs(delta) >= 18) {
    state.windTrend = delta > 0 ? 'veering' : 'backing';
  } else if (state.windTargetSpeed > state.simulatedWindSpeed + 2) {
    state.windTrend = 'freshening';
  } else if (state.windTargetSpeed < state.simulatedWindSpeed - 2) {
    state.windTrend = 'easing';
  } else {
    state.windTrend = 'variable';
  }
}

function updateWindSimulation(dtMinutes) {
  state.windSimulation = true;
  state.windChangeTimer -= dtMinutes;
  state.windGustTimer -= dtMinutes;

  if (state.windChangeTimer <= 0) {
    chooseNextWindTarget();
  }

  // Smoothly drift toward the target rather than snapping.
  const bearingDelta = shortestBearingDelta(state.simulatedWindBearing, state.windTargetBearing);
  const bearingStep = Math.sign(bearingDelta) * Math.min(Math.abs(bearingDelta), 0.65 * dtMinutes);
  state.simulatedWindBearing = (state.simulatedWindBearing + bearingStep + 360) % 360;

  const speedDelta = state.windTargetSpeed - state.simulatedWindSpeed;
  const speedStep = Math.sign(speedDelta) * Math.min(Math.abs(speedDelta), 0.35 * dtMinutes);
  state.simulatedWindSpeed = Math.max(0, Math.min(70, state.simulatedWindSpeed + speedStep));

  // Gusts fluctuate independently around the sustained wind.
  if (state.windGustTimer <= 0) {
    const gustExtra = 3 + Math.random() * Math.max(4, state.simulatedWindSpeed * 0.35);
    state.simulatedGust = Math.min(90, state.simulatedWindSpeed + gustExtra);
    state.windGustTimer = 2 + Math.random() * 5;
  } else {
    state.simulatedGust += (state.simulatedWindSpeed + 3 - state.simulatedGust) * Math.min(1, dtMinutes * .35);
  }

  updateWindUI();
}

function angularDifference(a, b) {
  let d = Math.abs((a - b) % 360);
  return d > 180 ? 360 - d : d;
}

function fireHeadPoint(lobe) {
  const brng = lobe.bearing * Math.PI / 180;
  return offsetPoint(
    lobe.ignition,
    lobe.head * Math.cos(brng),
    lobe.head * Math.sin(brng)
  );
}

function createFireLobe(origin, bearing, scale=1) {
  return {
    ignition: L.latLng(origin.lat, origin.lng),
    bearing,
    head: 28 * scale,
    rear: 12 * scale,
    flank: 18 * scale,
    active:true,
    areaHa:0
  };
}

function lobeCenter(lobe) {
  const centerShift = (lobe.head - lobe.rear) / 2;
  const brng = lobe.bearing * Math.PI / 180;
  return offsetPoint(
    lobe.ignition,
    centerShift * Math.cos(brng),
    centerShift * Math.sin(brng)
  );
}

function lobePolygonPoints(lobe, shrink=1) {
  const center = lobeCenter(lobe);
  const semiMajor = ((lobe.head + lobe.rear) / 2) * shrink;
  const flank = lobe.flank * shrink;
  return fireEllipsePoints(center, semiMajor, flank, lobe.bearing);
}

function firePointByBearing(origin, bearingDeg, distanceM) {
  const br = bearingDeg * Math.PI / 180;
  return offsetPoint(
    origin,
    distanceM * Math.cos(br),
    distanceM * Math.sin(br)
  );
}

function fireEnvelopePoints(fire, shrink=1) {
  const origin = fire.ignition;
  const samples = 96;
  const cloud = [];

  // fireEllipsePoints/lobePolygonPoints return [lat,lng] arrays.
  // Normalise them here before doing any geometry math.
  (fire.lobes || []).forEach(lobe => {
    lobePolygonPoints(lobe, shrink).forEach(p => {
      const lat = Array.isArray(p) ? Number(p[0]) : Number(p.lat);
      const lng = Array.isArray(p) ? Number(p[1]) : Number(p.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        cloud.push({lat, lng});
      }
    });
  });

  if (!cloud.length) {
    return fireEllipsePoints(origin, 12 * shrink, 10 * shrink, 0, samples);
  }

  // Determine a sane maximum extent from the lobe geometry itself.
  // This prevents one malformed calculation from drawing a red line across WA.
  let maxExpected = 20;
  (fire.lobes || []).forEach(lobe => {
    const dFromIgnition = haversineKm(origin, lobe.ignition) * 1000;
    maxExpected = Math.max(
      maxExpected,
      dFromIgnition + (Number(lobe.head) || 0) + (Number(lobe.flank) || 0) + 40
    );
  });
  const hardMax = Math.max(30, maxExpected * 1.25) * shrink;

  const out = [];

  for (let i = 0; i < samples; i++) {
    const bearing = (360 * i) / samples;
    let bestDist = Math.min(8 * shrink, hardMax);

    cloud.forEach(p => {
      const dx = (p.lng - origin.lng) * 111320 * Math.cos(origin.lat * Math.PI / 180);
      const dy = (p.lat - origin.lat) * 111320;

      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!Number.isFinite(dist) || dist > hardMax) return;

      const pointBearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      let diff = Math.abs(pointBearing - bearing);
      if (diff > 180) diff = 360 - diff;

      // Wider angular window avoids gaps between adjacent sampled lobes.
      if (diff <= 9.5 && dist > bestDist) {
        bestDist = dist;
      }
    });

    out.push(firePointByBearing(origin, bearing, bestDist));
  }

  const safeOut = out.filter(p => {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
    const d = haversineKm(origin, p) * 1000;
    return Number.isFinite(d) && d <= hardMax * 1.05;
  });

  return safeOut.length >= 8
    ? safeOut
    : fireEllipsePoints(origin, Math.min(20, hardMax), Math.min(14, hardMax * 0.7), 0, samples);
}


function incidentPopupHtml(f) {
  if (!f) return '';

  const lines = [
    `<b>${f.name}</b>`,
    `<b>${f.incidentType}</b>`,
    f.report || '',
    f.classification || 'Unclassified'
  ];

  if (isWildfireIncident(f)) {
    lines.push(`Approx. ${Number(f.areaHa || 0).toFixed(1)} ha • Head ${Math.round(f.head || 0)} m`);
    lines.push(`Containment ${Number(f.containment || 0).toFixed(1)}% • Control ${Number(f.controlProgress || 0).toFixed(1)}% • Mop-up ${Number(f.mopUp || 0).toFixed(1)}%`);
    lines.push(`Response: ${wildfireAlarmLabel(f.alarmLevel || 0)}`);
  } else {
    lines.push(`Resolution ${Number(f.resolution || 0).toFixed(1)}%`);
  }

  if (f.homeStation) {
    const distanceText = Number.isFinite(Number(f.distanceFromStation))
      ? ` • ${Number(f.distanceFromStation).toFixed(1)} km`
      : '';
    lines.push(`Generated near ${f.homeStation}${distanceText}`);
  }

  lines.push(`Age ${Math.floor(Number(f.age) || 0)} min`);
  lines.push(`Status: ${f.stage}`);

  return lines.filter(Boolean).join('<br>');
}

function addFire(latlng, forcedType=null) {
  const id = state.nextFire++;
  const name = `INC-${String(id).padStart(3,'0')}`;

  const incidentTypes = [
    { type:'Vegetation Fire', weight:45, growth:1.0,
      reports:['Smoke sighted from roadside.','Caller reports grass and scrub alight.','Multiple calls reporting a smoke column.'] },
    { type:'Escaped Burn-off', weight:22, growth:0.85,
      reports:['Private burn-off has escaped containment.','Caller reports burn pile spreading into paddock vegetation.'] },
    { type:'Lightning Start', weight:13, growth:1.15,
      reports:['Smoke reported after recent lightning activity.','Possible lightning-caused fire in bushland.'] },
    { type:'Vehicle Fire', weight:10, growth:0.15,
      reports:['Vehicle reported well alight near roadside vegetation.','Car fire reported with possible extension to grass.'] },
    { type:'Structure Fire', weight:10, growth:0.10,
      reports:['Shed reported on fire on a rural property.','Structure fire reported with nearby vegetation exposed.'] },
    { type:'Automatic Fire Alarm', weight:7, growth:0.02,
      reports:['Automatic fire alarm activation reported.','Monitoring company reports alarm activation at a commercial premises.'] },
    { type:'Road Crash Rescue', weight:7, growth:0.01,
      reports:['Serious crash reported with possible persons trapped.','Vehicle collision; rescue assistance requested.'] },
    { type:'Hazmat Incident', weight:4, growth:0.01,
      reports:['Unknown chemical spill reported at an industrial site.','Hazardous materials incident reported; area being isolated.'] },
    { type:'Building Fire', weight:7, growth:0.06,
      reports:['Smoke issuing from a building.','Multiple calls reporting a structure involved in fire.'] },
    { type:'Rescue Incident', weight:4, growth:0.01,
      reports:['Technical rescue assistance requested.','Person reported trapped; specialist rescue may be required.'] },
    { type:'Traffic Crash', weight:6, growth:0.01,
      reports:['Traffic crash reported; police attendance requested.','Collision blocking part of the roadway.'] },
    { type:'Disturbance', weight:5, growth:0.01,
      reports:['Public disturbance reported; police requested.','Caller reports an escalating disturbance.'] },
    { type:'Welfare Check', weight:4, growth:0.01,
      reports:['Welfare concern reported; police attendance requested.','Caller requests a welfare check.'] },
    { type:'Medical Emergency', weight:7, growth:0.01,
      reports:['Medical emergency reported; ambulance requested.','Caller reports a patient requiring urgent medical assistance.'] },
    { type:'Cardiac Arrest', weight:3, growth:0.01,
      reports:['Suspected cardiac arrest; ambulance response requested.','Caller reports an unresponsive patient.'] }
  ];

  function weightedType() {
    const total = incidentTypes.reduce((s,x) => s + x.weight, 0);
    let r = Math.random() * total;
    for (const x of incidentTypes) {
      r -= x.weight;
      if (r <= 0) return x;
    }
    return incidentTypes[0];
  }

  const chosen = forcedType
    ? incidentTypes.find(x => x.type === forcedType) || incidentTypes[0]
    : weightedType();

  const bearing = currentWindBearing();
  const scale = chosen.growth < .2 ? 0.35 : 1;
  const firstLobe = createFireLobe(latlng, bearing, scale);

  const fire = {
    id,
    name,
    incidentType: chosen.type,
    growthMultiplier: chosen.growth,
    ignition: L.latLng(latlng.lat, latlng.lng),
    center: L.latLng(latlng.lat, latlng.lng),
    age:0,
    areaHa:0,
    head:firstLobe.head,
    rear:firstLobe.rear,
    flank:firstLobe.flank,
    active:true,
    classification:'Unclassified',
    stage:'Reported',
    report:chosen.reports[Math.floor(Math.random() * chosen.reports.length)],
    assignments:[],
    sizeupDone:false,
    containment:0,
    controlProgress:0,
    mopUp:0,
    safeTimer:0,
    sectorsEstablished:false,
    machineSupervisor:false,
    containmentLine:null,
    mineralBreakLine:null,
    mineralBreakProgress:0,
    mineralBreakCompleteAnnounced:false,
    containedAnnounced:false,
    controlledAnnounced:false,
    alarmLevel:0,
    workflowProgress:{},
    workflowPhase:0,

    // Wind-shift model state
    lobes:[firstLobe],
    burnHistoryLayers:[],
    lastWindBearing:bearing,
    lastWindShiftAge:0
  };

  fire.center = lobeCenter(firstLobe);
  const semiMajor = (firstLobe.head + firstLobe.rear) / 2;
  fire.areaHa = (Math.PI * semiMajor * firstLobe.flank) / 10000;

  fire.burn = L.polygon(
    fireEnvelopePoints(fire, 0.78),
    { color:'#555', fillColor:'#111', fillOpacity:.28, weight:1 }
  ).addTo(map);

  fire.perimeter = L.polygon(
    fireEnvelopePoints(fire, 1),
    { color:fireColor(), fillColor:'#d94b3d', fillOpacity:.12, weight:3 }
  ).addTo(map);

  fire.marker = L.marker(latlng, {icon:makeIcon(name,'#8b1e17')}).addTo(map);
  fire.marker.bindPopup(incidentPopupHtml(fire));

  fire.marker.on('click', () => {
    state.selectedIncidentId = fire.id;
    renderIncidents();
  });

  state.fires.push(fire);
  state.selectedIncidentId = fire.id;
  log(`${name} reported — ${chosen.type}: ${fire.report}`);
  renderIncidents();
}


function applianceSuppression(fire) {
  let head = 0;
  let flank = 0;
  let general = 0;
  let property = 0;
  let blackout = 0;

  fire.assignments.forEach(asn => {
    if (asn.status !== 'On Scene') return;
    const found = allAppliances().find(x => x.appliance.id === asn.applianceId);
    if (!found) return;

    const a = found.appliance;
    if (a.currentWater <= 0 && a.task !== 'Refill') return;

    if (a.code === '12.2') return;

    const power = a.attack || 1;

    if (a.task === 'Head Attack') head += power * 1.4;
    else if (a.task === 'Left Flank' || a.task === 'Right Flank') flank += power * 1.15;
    else if (a.task === 'General Attack') general += power * 0.85;
    else if (a.task === 'Property Protection') property += power * 0.35;
    else if (a.task === 'Blackout') blackout += power;
  });

  return { head, flank, general, property, blackout };
}

function specialistSuppression(fire) {
  let air = 0;
  let plant = 0;

  state.specialResources.forEach(r => {
    if (r.fireId !== fire.id || r.status === 'Released') return;
    if (r.kind === 'air' && r.status === 'On Task') air += r.effect || 0;
    if (r.kind === 'plant' && r.status === 'Working') plant += r.effect || 0;
  });

  return { air, plant };
}


function completeIncident(fire, reason='Incident complete') {
  if (!fire || fire.completed) return;

  fire.completed = true;
  fire.active = false;
  fire.completedAt = state.minutes;

  // Save a lightweight archive entry for future reward/history systems.
  state.completedJobs = state.completedJobs || [];
  state.completedJobs.push({
    id: fire.id,
    name: fire.name,
    incidentType: fire.incidentType,
    classification: fire.classification,
    areaHa: Number(fire.areaHa) || 0,
    ageMinutes: Number(fire.age) || 0,
    containment: Number(fire.containment) || 0,
    completedAt: state.minutes,
    reason
  });

  if (els.completedJobsCount) {
    els.completedJobsCount.textContent = state.completedJobs.length;
  }

  // Remove all visible fire layers.
  [fire.marker, fire.perimeter, fire.burn, fire.containmentLine, fire.mineralBreakLine].forEach(layer => {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  });
  (fire.burnHistoryLayers || []).forEach(layer => {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  });

  // Release any resources that somehow remain attached.
  releaseAllIncidentAppliances(fire.id, reason);
  state.specialResources
    .filter(r => r.fireId === fire.id && r.status !== 'Released')
    .forEach(r => releaseSpecial(r.id));

  // Remove incident from active collection entirely.
  state.fires = state.fires.filter(x => x.id !== fire.id);

  if (state.selectedIncidentId === fire.id) {
    state.selectedIncidentId = state.fires.length
      ? state.fires[state.fires.length - 1].id
      : null;
  }

  log(`${fire.name} closed — ${fire.incidentType}, ${fire.areaHa.toFixed(1)} ha, ${Math.floor(fire.age)} min.`);
  renderIncidents();
}


function effectiveFireSuppression(fire) {
  const local = applianceSuppression(fire);
  const specialist = specialistSuppression(fire);

  let wetAttack = 0;
  let blackout = 0;

  fire.assignments.forEach(asn => {
    if (asn.status !== 'On Scene') return;
    const found = allAppliances().find(x => x.appliance.id === asn.applianceId);
    if (!found) return;

    const a = found.appliance;
    if (a.code === '12.2') return;

    const task = a.task;
    const hasWater = a.currentWater > 0;

    if (['Head Attack','Left Flank','Right Flank','General Attack','Property Protection'].includes(task) && hasWater) {
      wetAttack += (a.attack || 1);
    }

    if (task === 'Blackout' && hasWater) {
      blackout += (a.attack || 1);
    }
  });

  const air = specialist.air || 0;
  const plant = specialist.plant || 0;

  return {
    local,
    specialist,
    wetAttack,
    blackout,
    air,
    plant,
    total: wetAttack + blackout * 0.7 + air * 0.8 + plant * 0.8
  };
}


function wildfireAlarmForSize(areaHa) {
  const area = Math.max(0, Number(areaHa) || 0);

  // Gameplay thresholds for automatic escalation.
  // These can later be replaced by district/shire-specific matrices.
  if (area < 1.0) return 0;   // Initial Response
  if (area < 5.0) return 1;   // 1st Alarm
  if (area < 20.0) return 2;  // 2nd Alarm
  return 3;                   // 3rd Alarm
}

function updateWildfireAlarmFromSize(fire, initial=false) {
  if (!fire || !isWildfireIncident(fire)) return;

  const recommended = wildfireAlarmForSize(fire.areaHa);
  const current = Math.max(0, Math.min(3, Number(fire.alarmLevel) || 0));

  if (initial) {
    fire.alarmLevel = recommended;
    log(
      `${fire.name}: initial size-up classifies the incident as ` +
      `${wildfireAlarmLabel(recommended)} at ${fire.areaHa.toFixed(1)} ha.`
    );
    return;
  }

  // Fire growth may escalate the response level automatically.
  // Automatic logic never downgrades an alarm level.
  if (recommended > current) {
    fire.alarmLevel = recommended;
    log(
      `${fire.name}: fire growth has automatically elevated the response to ` +
      `${wildfireAlarmLabel(recommended)} (${fire.areaHa.toFixed(1)} ha).`
    );
  }
}

function spreadFire(f, dtMinutes) {
  if (!f.active) return;
  if (!isWildfireIncident(f)) {
    f.age += dtMinutes;
    return;
  }

  // Defensive migration for any incident created by an older build.
  if (!Array.isArray(f.lobes) || !f.lobes.length) {
    const bearing = currentWindBearing();
    const migrated = {
      ignition: L.latLng((f.ignition || f.center).lat, (f.ignition || f.center).lng),
      bearing,
      head: Number(f.head) || 28,
      rear: Number(f.rear) || 12,
      flank: Number(f.flank) || 18,
      active:true,
      areaHa:Number(f.areaHa) || 0
    };
    f.lobes = [migrated];
    f.burnHistoryLayers = f.burnHistoryLayers || [];
    f.lastWindBearing = bearing;
    f.lastWindShiftAge = Number(f.age) || 0;
  }

  const wind = currentWindSpeed();
  const fuel = currentFuelLoad();
  const currentBearing = currentWindBearing();
  const suppression = effectiveFireSuppression(f);
  const local = suppression.local;
  const specialist = suppression.specialist;

  const growthMultiplier = f.growthMultiplier || 1;
  const windBoost = Math.max(0.35, 0.55 + wind / 18);

  let activeLobe = f.lobes[f.lobes.length - 1];

  // Significant wind change creates a NEW head from the current head location.
  // The established burnt area and old perimeter stay where they were.
  const shift = angularDifference(activeLobe.bearing, currentBearing);
  const enoughTimeSinceShift = (f.age - (f.lastWindShiftAge || 0)) >= 2;

  if (shift >= 22.5 && enoughTimeSinceShift && f.stage !== 'Contained' && f.stage !== 'Controlled' && f.stage !== 'Safe') {
    activeLobe.active = false;

    // Keep one continuous fire perimeter. The old lobe remains part of
    // the fire shape; the new head overlaps it and becomes another "finger".
    const oldHead = fireHeadPoint(activeLobe);
    const br = activeLobe.bearing * Math.PI / 180;
    const overlapDistance = activeLobe.head * 0.18;
    const newOrigin = offsetPoint(
      oldHead,
      -overlapDistance * Math.cos(br),
      -overlapDistance * Math.sin(br)
    );

    // Start broad enough to overlap the established edge instead of looking
    // like a detached spot fire.
    const newLobe = createFireLobe(newOrigin, currentBearing, 0.62);
    f.lobes.push(newLobe);
    activeLobe = newLobe;

    f.lastWindBearing = currentBearing;
    f.lastWindShiftAge = f.age;

    log(`${f.name}: wind change established a new head toward ${currentWindDirectionLabel()}.`);
  }

  let headRate = 2.15 * windBoost * fuel * growthMultiplier;
  let flankRate = 1.05 * (0.75 + wind / 70) * fuel * growthMultiplier;
  let rearRate = 0.55 * (0.9 + wind / 120) * fuel * growthMultiplier;

  const headReduction = local.head * 0.20 + local.general * 0.08 + specialist.air * 0.18;
  const flankReduction = local.flank * 0.16 + local.general * 0.09 + specialist.air * 0.07;

  headRate *= Math.max(0.08, 1 - headReduction);
  flankRate *= Math.max(0.10, 1 - flankReduction);

  if ((f.airDropHoldTimer || 0) > 0) {
    const hold = Math.max(0.25, 1 - (f.airDropHoldStrength || 0));
    headRate *= hold;
    flankRate *= hold;
    rearRate *= hold;
    f.airDropHoldTimer = Math.max(0, f.airDropHoldTimer - dtMinutes);
    if (f.airDropHoldTimer <= 0) f.airDropHoldStrength = 0;
  }

  const lineFactor = Math.max(0.04, 1 - f.containment / 108);
  headRate *= lineFactor;
  flankRate *= lineFactor;
  rearRate *= lineFactor;

  // Mineral-earth breaks physically constrain spread rather than acting as
  // a cosmetic containment line. The more line plant completes, the less
  // perimeter can continue advancing through the constructed break.
  const breakProgress = Math.max(0, Math.min(100, Number(f.mineralBreakProgress) || 0));
  const breakFactor = breakProgress >= 98
    ? 0.015
    : Math.max(0.10, 1 - (breakProgress / 100) * 0.88);

  headRate *= breakFactor;
  flankRate *= breakFactor;
  rearRate *= breakFactor;

  if (f.stage === 'Contained' || f.stage === 'Controlled' || f.stage === 'Safe') {
    headRate *= 0.03;
    flankRate *= 0.03;
    rearRate *= 0.03;
  }

  activeLobe.head += headRate * dtMinutes;
  activeLobe.flank += flankRate * dtMinutes;
  activeLobe.rear += rearRate * dtMinutes;
  f.age += dtMinutes;

  // Old lobes remain fixed and the active lobe grows outward. Render all
  // lobes as one continuous, fingered fire perimeter.
  f.center = lobeCenter(activeLobe);
  f.head = activeLobe.head;
  f.rear = activeLobe.rear;
  f.flank = activeLobe.flank;

  f.perimeter.setLatLngs(fireEnvelopePoints(f, 1));
  f.burn.setLatLngs(fireEnvelopePoints(f, 0.80));

  // Approximate total burnt area by summing lobes.
  // Overlap is intentionally accepted for gameplay purposes.
  f.areaHa = f.lobes.reduce((sum, lobe) => {
    const semiMajor = (lobe.head + lobe.rear) / 2;
    lobe.areaHa = (Math.PI * semiMajor * lobe.flank) / 10000;
    return sum + lobe.areaHa;
  }, 0);

  if (f.sizeupDone) {
    updateWildfireAlarmFromSize(f, false);
  }

  // If crews stop actively suppressing the fire, containment/control can be lost.
  // The loss rate increases with fire pressure and drops when mineral-earth breaks,
  // air-drop hold, plant, or blackout are still providing meaningful control.
  const firePressureForLoss = Math.max(
    0.35,
    windBoost * fuel * growthMultiplier *
    (1 + Math.min(2.5, f.areaHa / 25))
  );

  const fixedControl =
    (f.mineralBreakProgress || 0) / 100 * 1.4 +
    suppression.plant * 0.8 +
    ((f.airDropHoldTimer || 0) > 0 ? 0.9 : 0) +
    suppression.blackout * 0.45;

  const activeControl = suppression.wetAttack + suppression.air * 0.7 + fixedControl;

  // Containment starts to erode when fire behaviour exceeds effective control.
  const controlDeficit = Math.max(0, firePressureForLoss - activeControl);

  // Once an incident has reached Controlled, normal background fire-pressure
  // deterioration no longer bleeds control away during mop-up. Control can only
  // be lost again through an explicit reignition/escalation event.
  if (
    f.sizeupDone &&
    controlDeficit > 0 &&
    f.stage !== 'Safe' &&
    f.stage !== 'Controlled' &&
    !(f.containment >= 99.95 && local.blackout > 0)
  ) {
    const containmentLossPerMinute = Math.min(
      2.2,
      0.10 + controlDeficit * 0.18
    );

    const controlLossPerMinute = Math.min(
      3.0,
      0.14 + controlDeficit * 0.24
    );

    // Deterioration is hierarchical:
    // once containment reaches 100%, accumulated control acts as the buffer.
    // Control must be lost all the way back to 0 before full containment
    // itself can begin to fall.
    const hadFullContainment = f.containment >= 99.95;

    if (hadFullContainment && f.controlProgress > 0) {
      f.containment = 100;
      f.controlProgress = Math.max(
        0,
        f.controlProgress - controlLossPerMinute * dtMinutes
      );
    } else {
      if (f.controlProgress > 0) {
        f.controlProgress = Math.max(
          0,
          f.controlProgress - controlLossPerMinute * dtMinutes
        );
      }

      if (f.controlProgress <= 0 && f.containment > 0) {
        f.containment = Math.max(
          0,
          f.containment - containmentLossPerMinute * dtMinutes
        );
      }
    }

    // Losing control does not instantly destroy full containment.
    // Controlled -> Contained when control drops substantially.
    // Contained -> Going only after control is exhausted and containment
    // itself has started to fail.
    if (f.stage === 'Controlled' && f.controlProgress < 90) {
      f.stage = 'Contained';
      f.controlledAnnounced = false;
      log(`${f.name}: control has deteriorated; incident remains fully contained.`);
    } else if (
      f.stage === 'Contained' &&
      f.controlProgress <= 0 &&
      f.containment < 95
    ) {
      f.stage = 'Going';
      f.containedAnnounced = false;
      f.controlledAnnounced = false;
      log(`${f.name}: control has been lost and containment is now failing.`);
    }

    // Ordinary control deterioration does not erase completed mop-up work.
    // Mop-up only drops on an explicit reignition/escalation event.
    if (f.controlProgress < 100) {
      f.safeTimer = 0;
    }
  }

  const suppressionScore =
    local.head +
    local.flank +
    local.general +
    specialist.air * 0.7 +
    specialist.plant * 1.1;

  const firePressure = Math.max(0.4, windBoost * fuel * growthMultiplier);

  if (f.sizeupDone && suppressionScore > 0 && f.stage !== 'Controlled' && f.stage !== 'Safe') {
    const gainPerMinute = Math.max(
      0.05,
      suppressionScore * 0.62 - firePressure * 0.24
    );
    f.containment = Math.min(100, f.containment + gainPerMinute * dtMinutes);
  }

  if (specialist.plant > 0) updateContainmentLine(f);

  if (f.containment >= 100 && f.stage !== 'Controlled' && f.stage !== 'Safe') {
    f.stage = 'Contained';
    if (!f.containedAnnounced) {
      f.containedAnnounced = true;
      log(`${f.name} is now CONTAINED.`);
    }
  }

  if (f.stage === 'Contained') {
    if (f.containment >= 99.95) {
      f.containment = 100;
    }

    const controlRate =
      local.blackout * 0.75 +
      suppressionScore * 0.12;

    if (controlRate > 0) {
      f.controlProgress = Math.min(
        100,
        f.controlProgress + controlRate * dtMinutes
      );
    }

    if (f.controlProgress >= 100) {
      f.stage = 'Controlled';
      if (!f.controlledAnnounced) {
        f.controlledAnnounced = true;
        log(`${f.name} is now CONTROLLED.`);
      }
    }
  }

  if (f.stage === 'Controlled') {
    // Repair legacy/in-flight states where control had already drifted below 100
    // despite the incident still being classified Controlled.
    if (f.controlProgress < 100) {
      f.controlProgress = 100;
    }

    const mopRate = local.blackout * 0.9;
    if (mopRate > 0) {
      f.mopUp = Math.min(100, f.mopUp + mopRate * dtMinutes);
    }

    if (f.mopUp >= 100 && f.controlProgress >= 100 && f.containment >= 100) {
      f.safeTimer += dtMinutes;
      if (f.safeTimer >= 15) {
        f.stage = 'Safe';
        log(`${f.name} is now SAFE.`);
        completeIncident(f, 'Incident Safe');
        return;
      }
    } else {
      f.safeTimer = 0;

      if (Math.random() < 0.00002 * dtMinutes * Math.max(1, wind / 10)) {
        f.stage = 'Contained';
        f.controlProgress = Math.max(35, f.controlProgress - 25);
        f.mopUp = Math.min(f.mopUp, f.controlProgress);
        log(`${f.name} has REIGNITED during mop-up.`);
      }
    }
  }

  if (f.sizeupDone && f.areaHa > 10 && !f.classification.includes('Escalating')) {
    f.classification = `${f.incidentType || 'Bushfire'} — Escalating`;
  }

  if (f.marker) {
    f.marker.setPopupContent(incidentPopupHtml(f));
  }
}
