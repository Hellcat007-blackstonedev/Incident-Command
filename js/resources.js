/* Routing, turnout, agency tasking, aircraft, DBCA plant and resource lifecycle. */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function allAppliances() {
  const out = [];
  state.stations.forEach(station => {
    station.appliances.forEach(appliance => {
      out.push({ station, appliance });
    });
  });
  return out;
}



async function fetchWithTimeout(url, timeoutMs=2200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getRoadRoute(start, end) {
  const straightKm = haversineKm(start, end);

  async function nearestRoad(point) {
    const url = `https://router.project-osrm.org/nearest/v1/driving/${point.lng},${point.lat}?number=1`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error('nearest-road lookup failed');
    const data = await res.json();
    if (!data.waypoints || !data.waypoints[0]) throw new Error('no routable road found');
    const wp = data.waypoints[0];
    return {
      point: L.latLng(wp.location[1], wp.location[0]),
      snapDistanceM: wp.distance || 0,
      name: wp.name || ''
    };
  }

  try {
    const snappedStart = await nearestRoad(start);
    const snappedEnd = await nearestRoad(end);

    const url = `https://router.project-osrm.org/route/v1/driving/` +
      `${snappedStart.point.lng},${snappedStart.point.lat};` +
      `${snappedEnd.point.lng},${snappedEnd.point.lat}` +
      `?overview=full&geometries=geojson`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error('routing failed');

    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('no route');

    const roadCoords = route.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
    const roadKm = route.distance / 1000;
    const firegroundKm = haversineKm(snappedEnd.point, end);
    const stationAccessKm = haversineKm(start, snappedStart.point);

    // Build one continuous path:
    // station -> snapped road -> routed road path -> nearest road access -> fire
    const coords = [
      L.latLng(start.lat, start.lng),
      ...roadCoords,
      L.latLng(end.lat, end.lng)
    ];

    return {
      coords,
      roadCoords,
      snappedStart: snappedStart.point,
      snappedEnd: snappedEnd.point,
      roadDistanceKm: roadKm,
      stationAccessKm,
      firegroundKm,
      distanceKm: stationAccessKm + roadKm + firegroundKm,
      straightKm,
      usedFallback: false,
      accessRoadName: snappedEnd.name
    };
  } catch (e) {
    // Last-resort fallback only if the routing service genuinely fails.
    // No longer reject a valid route merely because it looks indirect.
    return {
      coords:[L.latLng(start.lat,start.lng), L.latLng(end.lat,end.lng)],
      roadCoords:[],
      snappedStart:L.latLng(start.lat,start.lng),
      snappedEnd:L.latLng(end.lat,end.lng),
      roadDistanceKm:0,
      stationAccessKm:0,
      firegroundKm:straightKm,
      distanceKm:straightKm,
      straightKm,
      usedFallback:true,
      accessRoadName:''
    };
  }
}

function routePointAt(coords, progress) {
  if (!coords || coords.length < 2) return coords && coords[0];
  const segs = [];
  let total = 0;
  for (let i=1;i<coords.length;i++) {
    const d = haversineKm(coords[i-1], coords[i]);
    segs.push(d);
    total += d;
  }
  let target = total * Math.max(0, Math.min(1, progress));
  for (let i=0;i<segs.length;i++) {
    if (target <= segs[i]) {
      const p = segs[i] ? target / segs[i] : 0;
      return L.latLng(
        coords[i].lat + (coords[i+1].lat - coords[i].lat) * p,
        coords[i].lng + (coords[i+1].lng - coords[i].lng) * p
      );
    }
    target -= segs[i];
  }
  return coords[coords.length-1];
}


function getIncidentICP(fire) {
  if (!fire || !fire.icpId) return null;
  return state.icps.find(i => i.id === fire.icpId) || null;
}

function incidentResponseTarget(fire) {
  const icp = getIncidentICP(fire);
  return icp ? icp.latlng : (fire.ignition || fire.center);
}

async function dispatchAppliance(fireId, applianceId) {
  const fire = state.fires.find(f => f.id === fireId);
  const found = allAppliances().find(x => x.appliance.id === applianceId);

  const returning = (state.returningAppliances || []).find(r => r.applianceId === applianceId);

  if (!fire || !found || found.appliance.status !== 'Available') {
    log('Unable to dispatch that appliance.');
    return;
  }

  // If this appliance is returning, dispatch it from its current road position.
  let dispatchOrigin = found.station.latlng;
  if (returning) {
    if (returning.marker) dispatchOrigin = returning.marker.getLatLng();
    else if (returning.currentPos) dispatchOrigin = returning.currentPos;

    if (returning.marker && map.hasLayer(returning.marker)) map.removeLayer(returning.marker);
    if (returning.routeLine && map.hasLayer(returning.routeLine)) map.removeLayer(returning.routeLine);
    state.returningAppliances = state.returningAppliances.filter(r => r.applianceId !== applianceId);

    log(`${found.appliance.callsign} diverted from return-to-station to ${fire.name}.`);
  }

  const isRescueAircraft = found.appliance.code === 'Rescue Helicopter';

  if (isRescueAircraft) {
    const target = fire.ignition || fire.center;
    const airSpeed = Number(found.appliance.airSpeed) || 250;
    const launchDelayMin = 1.5;
    const straightKm = haversineKm(dispatchOrigin, target);
    const eta = Math.max(1.5, launchDelayMin + (straightKm / airSpeed) * 60);

    found.appliance.status = 'En Route';
    found.appliance.assignment = fire.id;
    found.appliance.eta = eta;

    const marker = L.marker(dispatchOrigin, {
      icon:specialIcon('air'),
      zIndexOffset:950
    }).addTo(map);
    marker.bindTooltip(`${found.appliance.callsign} • ${Math.ceil(eta)} min`, {
      direction:'top'
    });

    const routeCoords = [
      L.latLng(dispatchOrigin.lat, dispatchOrigin.lng),
      L.latLng(target.lat, target.lng)
    ];

    const routeLine = L.polyline(routeCoords, {
      color:'#3b6ea8',
      weight:2,
      dashArray:'6 6',
      opacity:.65
    }).addTo(map);

    fire.assignments.push({
      applianceId,
      stationId:found.station.id,
      callsign:found.appliance.callsign,
      status:'En Route',
      eta,
      totalEta:eta,
      distance:straightKm,
      straightDistance:straightKm,
      roadDistance:null,
      firegroundDistance:0,
      routeFallback:false,
      routeCoords,
      marker,
      routeLine,
      firegroundLine:null,
      routingPending:false,
      destinationType:'Incident',
      phase:Math.random() * Math.PI * 2,
      airUnit:true
    });

    if (fire.stage === 'Reported') fire.stage = 'Responding';

    log(`${found.appliance.callsign} airborne from ${found.station.name} to ${fire.name}; ETA ${Math.ceil(eta)} min.`);
    renderStations();
    renderIncidents();
    return;
  }

  const icp = getIncidentICP(fire);

  if (found.appliance.code === '12.2' && !icp) {
    log(`${found.appliance.callsign} cannot be dispatched to ${fire.name}: establish an ICP first. 12.2 appliances stage at control points as bulk-water sources only.`);
    return;
  }

  const target = incidentResponseTarget(fire);
  const roadKmh = found.appliance.code === '12.2' ? 80 : 100;
  const firegroundKmh = found.appliance.code === '12.2' ? 30 : 45;
  const turnoutDelayMin = 1.25;

  // Turn the appliance out IMMEDIATELY. Routing is allowed to improve the
  // route afterwards, but it is never allowed to block dispatch.
  const straightKm = haversineKm(dispatchOrigin, target);
  const provisionalDistance = Math.max(0.1, straightKm * 1.12);
  const provisionalEta = Math.max(
    2,
    turnoutDelayMin + (provisionalDistance / roadKmh) * 60
  );

  found.appliance.status = 'En Route';
  found.appliance.assignment = fire.id;
  found.appliance.eta = provisionalEta;

  const blipIcon = L.divIcon({
    className:'',
    html:'<div class="appliance-blip"></div>',
    iconSize:[16,16],
    iconAnchor:[8,8]
  });

  const marker = L.marker(dispatchOrigin, {
    icon:blipIcon,
    zIndexOffset:900
  }).addTo(map);

  marker.bindTooltip(`${found.appliance.callsign} • calculating route`, {
    permanent:false,
    direction:'top',
    className:'appliance-label',
    offset:[0,-8]
  });

  const provisionalCoords = [
    L.latLng(dispatchOrigin.lat, dispatchOrigin.lng),
    L.latLng(target.lat, target.lng)
  ];

  const routeLine = L.polyline(provisionalCoords, {
    color:'#777',
    weight:2,
    dashArray:'3 7',
    opacity:.45
  }).addTo(map);

  const assignment = {
    applianceId,
    stationId:found.station.id,
    callsign:found.appliance.callsign,
    status:'En Route',
    eta:provisionalEta,
    totalEta:provisionalEta,
    distance:provisionalDistance,
    straightDistance:straightKm,
    roadDistance:null,
    firegroundDistance:0,
    routeFallback:true,
    routeCoords:provisionalCoords,
    marker,
    routeLine,
    firegroundLine:null,
    routingPending:true,
    destinationType: icp ? 'ICP' : 'Incident',
    phase: Math.random() * Math.PI * 2
  };

  fire.assignments.push(assignment);

  if (fire.stage === 'Reported') fire.stage = 'Responding';

  log(`${found.appliance.callsign} TURNED OUT to ${fire.name}${icp ? ` via ICP ${icp.id}` : ''}; route calculation in progress.`);
  renderStations();
  renderIncidents();

  // Improve the route asynchronously. Failure simply leaves the provisional
  // route in place instead of trapping the appliance in a "Routing" state.
  try {
    const route = await getRoadRoute(dispatchOrigin, target);

    // It may have arrived/released while routing was being calculated.
    if (assignment.status !== 'En Route') return;

    const elapsed = Math.max(0, assignment.totalEta - assignment.eta);

    let recalculatedEta;
    if (!route.usedFallback) {
      const roadTravelMin = (route.roadDistanceKm / roadKmh) * 60;
      const stationAccessMin = (route.stationAccessKm / 35) * 60;
      const firegroundTravelMin = (route.firegroundKm / firegroundKmh) * 60;
      recalculatedEta = Math.max(
        2,
        turnoutDelayMin + stationAccessMin + roadTravelMin + firegroundTravelMin
      );
    } else {
      recalculatedEta = Math.max(
        2,
        turnoutDelayMin + (route.distanceKm / roadKmh) * 60
      );
    }

    assignment.totalEta = recalculatedEta;
    assignment.eta = Math.max(0.05, recalculatedEta - elapsed);
    assignment.distance = route.distanceKm;
    assignment.roadDistance = route.roadDistanceKm;
    assignment.firegroundDistance = route.firegroundKm;
    assignment.routeFallback = route.usedFallback;
    assignment.routeCoords = route.coords;
    assignment.routingPending = false;
    found.appliance.eta = assignment.eta;

    if (assignment.routeLine && map.hasLayer(assignment.routeLine)) {
      map.removeLayer(assignment.routeLine);
    }
    if (assignment.firegroundLine && map.hasLayer(assignment.firegroundLine)) {
      map.removeLayer(assignment.firegroundLine);
    }

    if (!route.usedFallback && route.roadCoords.length > 1) {
      assignment.routeLine = L.polyline(route.roadCoords, {
        color:'#4d9de0',
        weight:2,
        dashArray:'5 6',
        opacity:.75
      }).addTo(map);

      if (route.firegroundKm > 0.03) {
        assignment.firegroundLine = L.polyline([route.snappedEnd, target], {
          color:'#e6a23c',
          weight:2,
          dashArray:'3 5',
          opacity:.8
        }).addTo(map);
      }

      const accessText = route.firegroundKm > 0.03
        ? ` + ${route.firegroundKm.toFixed(1)} km fireground access`
        : '';

      log(
        `${found.appliance.callsign} route confirmed: ` +
        `${route.roadDistanceKm.toFixed(1)} km by road${accessText}; ETA ${Math.ceil(assignment.eta)} min.`
      );
    } else {
      assignment.routeLine = L.polyline(route.coords, {
        color:'#d94b3d',
        weight:2,
        dashArray:'3 7',
        opacity:.7
      }).addTo(map);

      log(
        `${found.appliance.callsign}: road router unavailable; ` +
        `fallback response remains active, ETA ${Math.ceil(assignment.eta)} min.`
      );
    }

    renderStations();
    renderIncidents();

  } catch (err) {
    assignment.routingPending = false;
    console.error('Route calculation failed:', err);
    log(
      `${found.appliance.callsign}: road routing timed out; ` +
      `fallback response continues, ETA ${Math.ceil(assignment.eta)} min.`
    );
    renderStations();
    renderIncidents();
  }
}

function completeSizeup(fire, assignment) {
  if (fire.sizeupDone) return;

  fire.sizeupDone = true;
  fire.stage = 'Going';

  const wind = currentWindSpeed();
  const fuel = currentFuelLoad();

  if (isWildfireIncident(fire)) {
    if (fire.areaHa < 1.0) fire.classification = 'Small Vegetation Fire';
    else if (fire.areaHa < 5) fire.classification = 'Bushfire — Developing';
    else if (fire.areaHa < 20) fire.classification = 'Bushfire — Escalating';
    else fire.classification = 'Major Bushfire';

    updateWildfireAlarmFromSize(fire, true);

    let behaviour = 'low to moderate';
    if (wind >= 25 || fuel >= 1.4) behaviour = 'high';
    if (wind >= 45 || fuel >= 1.9) behaviour = 'very high';

    log(
      `${assignment.callsign} on scene at ${fire.name}. SIZE-UP: ` +
      `${fire.areaHa.toFixed(1)} ha, ${behaviour} fire behaviour, ` +
      `${wildfireAlarmLabel(fire.alarmLevel)} response, ` +
      `wind ${currentWindSpeed().toFixed(0)} km/h ${currentWindDirectionLabel()}.`
    );

    fire.marker.setPopupContent(incidentPopupHtml(fire));
  } else {
    const classifications = {
      'Road Crash Rescue':'Road Crash Rescue — Persons Reported Trapped',
      'Traffic Crash':'Traffic Crash',
      'Hazmat Incident':'Hazmat Incident',
      'Rescue Incident':'Technical Rescue',
      'Automatic Fire Alarm':'Automatic Fire Alarm',
      'Medical Emergency':'Medical Emergency',
      'Cardiac Arrest':'Cardiac Arrest',
      'Disturbance':'Police Incident — Disturbance',
      'Welfare Check':'Police Incident — Welfare Check'
    };

    fire.classification = classifications[fire.incidentType] || fire.incidentType;
    fire.resolution = fire.resolution || 0;

    log(`${assignment.callsign} on scene at ${fire.name}. SIZE-UP: ${fire.classification}.`);
    fire.marker.setPopupContent(incidentPopupHtml(fire));
  }
}



function updateAgencyIncidentProgress(fire, dtMinutes) {
  if (isWildfireIncident(fire) || !fire.sizeupDone) return;

  ensureWorkflowState(fire);
  const phases = incidentWorkflowPhases(fire);
  if (!phases.length) return;

  // Minimum attendance is a hard operational prerequisite.
  // Crews may be assigned tasks, but the job will not advance until
  // the required response has physically arrived.
  if (!minimumRequirementsMet(fire)) return;

  if (fire.workflowPhase >= phases.length) {
    fire.resolution = 100;
    if (!fire.completed) {
      fire.stage = 'Safe';
      log(`${fire.name} resolved and closed.`);
      completeIncident(fire, 'Incident Resolved');
    }
    return;
  }

  const phase = phases[fire.workflowPhase];

  phase.forEach(step => {
    const workers = fire.assignments.filter(asn => {
      if (asn.status !== 'On Scene') return false;
      const found = allAppliances().find(x => x.appliance.id === asn.applianceId);
      if (!found) return false;
      return applianceAgency(found) === step.agency && found.appliance.task === step.task;
    }).length;

    if (!workers) return;

    const current = Number(fire.workflowProgress[step.id]) || 0;
    const rate = 100 / Math.max(0.5, Number(step.duration) || 2);
    const workerBoost = 1 + Math.max(0, workers - 1) * 0.35;
    const next = Math.min(100, current + rate * workerBoost * dtMinutes);
    fire.workflowProgress[step.id] = next;

    if (current < 100 && next >= 100) {
      log(`${fire.name}: ${step.task} complete.`);
    }
  });

  const phaseComplete = phase.every(step => (fire.workflowProgress[step.id] || 0) >= 100);
  if (phaseComplete) {
    fire.workflowPhase += 1;
    if (fire.workflowPhase < phases.length) {
      const next = phases[fire.workflowPhase].map(s => `${agencyLabel(s.agency)} ${s.task}`).join(' • ');
      log(`${fire.name}: next operational step — ${next}.`);
    }
  }

  const allSteps = phases.flat();
  const totalProgress = allSteps.reduce((sum, step) => {
    return sum + Math.min(100, Number(fire.workflowProgress[step.id]) || 0);
  }, 0);

  fire.resolution = allSteps.length
    ? Math.min(100, totalProgress / allSteps.length)
    : 0;

  if (fire.workflowPhase >= phases.length && !fire.completed) {
    fire.resolution = 100;
    fire.stage = 'Safe';
    log(`${fire.name} resolved and closed.`);
    completeIncident(fire, 'Incident Resolved');
  }
}

function updateAssignments(dtMinutes) {
  state.fires.forEach(fire => {
    fire.assignments.forEach(asn => {
      const found = allAppliances().find(x => x.appliance.id === asn.applianceId);
      if (!found) return;
      const a = found.appliance;

      if (asn.status === 'En Route') {
        asn.eta -= dtMinutes;
        a.eta = Math.max(0, asn.eta);

        const turnoutDelay = 1.25;
        const elapsed = asn.totalEta - asn.eta;
        const travelDuration = Math.max(0.1, asn.totalEta - turnoutDelay);
        const progress = elapsed <= turnoutDelay
          ? 0
          : Math.min(1, Math.max(0, (elapsed - turnoutDelay) / travelDuration));
        const point = routePointAt(asn.routeCoords, progress);

        if (asn.marker && point) {
          asn.marker.setLatLng(point);
          const simMinutesLeft = Math.max(0, asn.eta);
          const realSecondsLeft = (simMinutesLeft * 60) / Math.max(1, state.speed);
          asn.marker.setTooltipContent(
            `${asn.callsign} • ${Math.ceil(simMinutesLeft)} min` +
            `${asn.routingPending ? ' • routing…' : ''}`
          );
        }

        if (asn.eta <= 0) {
          const icp = getIncidentICP(fire);
          a.eta = 0;
          a.task = 'None';

          if (asn.routeLine && map.hasLayer(asn.routeLine)) map.removeLayer(asn.routeLine);
          if (asn.firegroundLine && map.hasLayer(asn.firegroundLine)) map.removeLayer(asn.firegroundLine);

          if (icp) {
            asn.status = 'At ICP';
            a.status = 'At ICP';

            if (a.code === '12.2') {
              a.task = 'Water Supply';
            }

            if (asn.marker) {
              asn.marker.setLatLng(icp.latlng);
              asn.marker.setTooltipContent(
                a.code === '12.2'
                  ? `${asn.callsign} • ICP water supply • ${Math.round(a.currentWater).toLocaleString()} L`
                  : `${asn.callsign} • At ICP • awaiting task`
              );
            }

            if (a.code === '12.2') {
              log(`${asn.callsign} arrived at ICP ${icp.id} for ${fire.name} and established bulk water supply.`);
            } else {
              log(`${asn.callsign} arrived at ICP ${icp.id} for ${fire.name}; awaiting tasking.`);
            }

            completeSizeup(fire, asn);
          } else {
            asn.status = 'On Scene';
            a.status = 'On Scene';
            if (asn.marker) {
              asn.marker.setLatLng(fire.ignition);
              asn.marker.setTooltipContent(`${asn.callsign} • On Scene`);
            }
            log(`${asn.callsign} arrived at ${fire.name}.`);
            completeSizeup(fire, asn);
          }
        }
      } else if (asn.status === 'At ICP') {
        if (asn.marker) {
          const icp = getIncidentICP(fire);
          if (icp) asn.marker.setLatLng(icp.latlng);
        }
      } else if (asn.status === 'On Scene') {
        // Visual fireground movement: tasked appliances circulate around the incident.
        if (a.task !== 'None' && a.task !== 'Refill' && asn.marker) {
          asn.phase = (asn.phase || 0) + dtMinutes * 0.35;
          const radius = Math.max(55, Math.min(280, 45 + Math.sqrt(Math.max(0.1, fire.areaHa) * 10000 / Math.PI)));
          let sectorOffset = 0;
          if (a.task === 'Head Attack') sectorOffset = currentWindBearing() * Math.PI / 180;
          else if (a.task === 'Left Flank') sectorOffset = currentWindBearing() * Math.PI / 180 - Math.PI/2;
          else if (a.task === 'Right Flank') sectorOffset = currentWindBearing() * Math.PI / 180 + Math.PI/2;
          else sectorOffset = asn.phase;

          const angle = sectorOffset + Math.sin(asn.phase * 0.7) * 0.35;
          const p = offsetPoint(fire.ignition, Math.cos(angle) * radius, Math.sin(angle) * radius);
          asn.marker.setLatLng(p);
          asn.marker.setTooltipContent(`${asn.callsign} • ${a.task}`);
        }

        // Water use and refill.
        const waterUseRates = {
          'Head Attack':28,
          'Left Flank':28,
          'Right Flank':28,
          'General Attack':28,
          'Property Protection':18,
          'Blackout':12,

          // Structural / vehicle / rescue fireground work.
          'Fire Attack':40,
          'Overhaul':14,
          'Fire Protection':16
        };

        const useRate = waterUseRates[a.task] || 0;

        if (useRate > 0 && a.maxWater > 0 && a.currentWater > 0) {
          a.currentWater = Math.max(0, a.currentWater - useRate * dtMinutes);

          if (a.currentWater <= 0) {
            a.task = 'None';
            log(`${a.callsign} is OUT OF WATER and has stopped active water application.`);
          }
        } else if (useRate > 0 && a.maxWater > 0 && a.currentWater <= 0) {
          a.task = 'None';
        } else if (a.task === 'Refill') {
          const sources = bulkWaterSourcesForIncident(fire);
          const source = sources[0];

          if (source) {
            const needed = Math.max(0, a.maxWater - a.currentWater);
            const transfer = Math.min(needed, 420 * dtMinutes, source.appliance.currentWater);

            a.currentWater += transfer;
            source.appliance.currentWater -= transfer;

            if (source.asn.marker) {
              source.asn.marker.setTooltipContent(
                `${source.appliance.callsign} • ICP water supply • ${Math.round(source.appliance.currentWater).toLocaleString()} L`
              );
            }

            if (source.appliance.currentWater <= 0) {
              log(`${source.appliance.callsign} bulk water supply is EMPTY.`);
            }
          } else {
            // No bulk-water tanker at the ICP: retain a slower abstract local refill.
            a.currentWater = Math.min(a.maxWater, a.currentWater + 140 * dtMinutes);
          }

          if (a.currentWater >= a.maxWater) {
            a.currentWater = a.maxWater;
            a.task = 'None';
            log(`${a.callsign} refill complete.`);
          }
        }
      }
    });
  });
}


function specialIcon(kind) {
  if (kind === 'air') {
    return L.divIcon({className:'', html:'<div class="air-blip"></div>', iconSize:[18,18], iconAnchor:[9,9]});
  }
  return L.divIcon({className:'', html:'<div class="plant-blip"></div>', iconSize:[18,18], iconAnchor:[9,9]});
}

async function requestSpecialResource(fireId, type) {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire) return;

  const presets = {
    LAT:{kind:'air', label:'LAT', code:'LAT', cycle:16, effect:1.6, airSpeed:430, launchDelay:5},
    HELI:{kind:'air', label:'Helitac', code:'Helitac', cycle:10, effect:1.0, airSpeed:220, launchDelay:3},
    SEAT:{kind:'air', label:'SEAT', code:'SEAT', cycle:12, effect:0.9, airSpeed:300, launchDelay:4},
    LOADER:{kind:'plant', label:'DBCA Loader', effect:.7, code:'DBCA Loader', roadKmh:55},
    DOZER:{kind:'plant', label:'DBCA Dozer', effect:1.2, code:'DBCA Dozer', roadKmh:45}
  };
  const p = presets[type];
  if (!p) return;

  const activeLatCountStatewide = type === 'LAT'
    ? state.specialResources.filter(r =>
        r.type === 'LAT' &&
        r.status !== 'Released'
      ).length
    : 0;

  // WA has one local LAT available statewide. If that LAT is already committed
  // anywhere, every additional concurrent LAT request is an interstate deployment.
  const secondLatFromNSW = type === 'LAT' && activeLatCountStatewide >= 1;

  const id = state.nextSpecialId++;

  if (p.kind === 'plant') {
    const candidates = allAppliances()
      .filter(x =>
        x.station.type === 'DBCA' &&
        x.appliance.code === p.code &&
        x.appliance.status === 'Available'
      )
      .sort((a,b) =>
        haversineKm(a.station.latlng, fire.ignition) -
        haversineKm(b.station.latlng, fire.ignition)
      );

    const found = candidates[0];
    if (!found) {
      log(`${p.label} unavailable: place a DBCA depot/work centre with an available ${p.code === 'DBCA Dozer' ? 'Dozer' : 'Loader'} first.`);
      return;
    }

    found.appliance.status = 'En Route';
    found.appliance.assignment = fire.id;

    let route;
    try {
      route = await getRoadRoute(found.station.latlng, fire.ignition);
    } catch (err) {
      const d = haversineKm(found.station.latlng, fire.ignition);
      route = {
        coords:[found.station.latlng, fire.ignition],
        distanceKm:d,
        usedFallback:true
      };
    }

    const eta = Math.max(2, 2 + (route.distanceKm / p.roadKmh) * 60);
    found.appliance.eta = eta;

    const marker = L.marker(found.station.latlng, {
      icon:specialIcon('plant'),
      zIndexOffset:850
    }).addTo(map);
    marker.bindTooltip(`${found.appliance.callsign} • ${Math.ceil(eta)} min`, {direction:'top'});

    const routeLine = L.polyline(route.coords, {
      color:'#6b5b35',
      weight:2,
      dashArray:'5 6',
      opacity:.75
    }).addTo(map);

    state.specialResources.push({
      id, fireId, type, ...p,
      label:found.appliance.callsign,
      status:'Inbound',
      eta,
      totalEta:eta,
      start:found.station.latlng,
      marker,
      routeLine,
      routeCoords:route.coords,
      cycleTimer:0,
      plantApplianceId:found.appliance.id,
      plantStationId:found.station.id
    });

    log(`${found.appliance.callsign} turned out from ${found.station.name} to ${fire.name}; road ETA ${Math.ceil(eta)} min.`);
    renderStations();
    renderIncidents();
    return;
  }

  // Prefer aircraft explicitly assigned to a placed airfield.
  const aircraftCandidates = allAppliances()
    .filter(x =>
      x.station.type === 'AIRBASE' &&
      x.appliance.code === p.code &&
      x.appliance.status === 'Available'
    )
    .sort((a,b) =>
      haversineKm(a.station.latlng, fire.ignition) -
      haversineKm(b.station.latlng, fire.ignition)
    );

  const aircraft = secondLatFromNSW ? null : aircraftCandidates[0];
  let start;
  let sourceName;
  let resourceLabel = p.label;

  if (secondLatFromNSW) {
    // Because apparently WA has decided one LAT isn't enough today.
    // The second LAT for the same incident is an interstate deployment from NSW.
    start = L.latLng(-33.6006, 150.7808);
    sourceName = 'NSW Interstate Air Tanker Base';
    resourceLabel = 'NSW LAT';
  } else if (aircraft) {
    const returningResource = state.specialResources.find(r =>
      r.kind === 'air' &&
      r.aircraftApplianceId === aircraft.appliance.id &&
      r.status === 'Returning'
    );

    if (returningResource && returningResource.marker) {
      start = returningResource.marker.getLatLng();
      sourceName = `${aircraft.station.name} (diverted while returning)`;
      if (map.hasLayer(returningResource.marker)) {
        map.removeLayer(returningResource.marker);
      }
      returningResource.status = 'Released';
    } else {
      start = aircraft.station.latlng;
      sourceName = aircraft.station.name;
    }

    resourceLabel = aircraft.appliance.callsign;
    aircraft.appliance.status = 'En Route';
    aircraft.appliance.assignment = fire.id;
  } else if (type === 'LAT') {
    // Default first-LAT fallback: Busselton Margaret River Airport.
    start = L.latLng(-33.6878, 115.4003);
    sourceName = 'Busselton Airport';
  } else {
    // Default Helitac / SEAT fallback: Jandakot Airport.
    start = L.latLng(-32.096699, 115.882004);
    sourceName = 'Jandakot Airport';
  }

  const distanceKm = haversineKm(start, fire.ignition);
  const eta = Math.max(
    p.launchDelay,
    p.launchDelay + (distanceKm / p.airSpeed) * 60
  );

  if (aircraft) aircraft.appliance.eta = eta;

  const marker = L.marker(start, {icon:specialIcon('air'), zIndexOffset:850}).addTo(map);
  marker.bindTooltip(`${resourceLabel} • ${Math.ceil(eta)} min`, {direction:'top'});

  state.specialResources.push({
    id, fireId, type, ...p,
    label:resourceLabel,
    status:'Inbound',
    eta,
    totalEta:eta,
    start,
    marker,
    cycleTimer:0,
    orbitPhase:Math.random() * Math.PI * 2,
    aircraftApplianceId:aircraft ? aircraft.appliance.id : null,
    aircraftStationId:aircraft ? aircraft.station.id : null
  });

  if (secondLatFromNSW) {
    log(`Additional LAT requested for ${fire.name}. WA's local LAT is already committed — NSW LAT inbound; ETA ${Math.ceil(eta)} min.`);
  } else {
    log(`${resourceLabel} requested for ${fire.name} from ${sourceName}; ETA ${Math.ceil(eta)} min.`);
  }
  renderStations();
  renderIncidents();
}

function releaseSpecial(id) {
  const r = state.specialResources.find(x => x.id === id);
  if (!r || r.status === 'Released' || r.status === 'Returning') return;

  if (r.routeLine && map.hasLayer(r.routeLine)) map.removeLayer(r.routeLine);

  // Aircraft remain visible and unavailable until they physically return
  // to the airfield/base they originally launched from.
  if (r.kind === 'air' && r.marker && r.start) {
    const current = r.marker.getLatLng();
    const speedKmh = Math.max(120, Number(r.airSpeed) || 220);
    const distanceKm = haversineKm(current, r.start);
    const eta = Math.max(0.5, (distanceKm / speedKmh) * 60);

    r.returnStart = L.latLng(current.lat, current.lng);
    r.returnTarget = L.latLng(r.start.lat, r.start.lng);
    r.returnEta = eta;
    r.returnTotalEta = eta;
    r.status = 'Returning';

    r.marker.setTooltipContent(`${r.label} • returning ${Math.ceil(eta)} min`);

    if (r.aircraftApplianceId) {
      const found = allAppliances().find(x => x.appliance.id === r.aircraftApplianceId);
      if (found) {
        found.appliance.status = 'Available';
        found.appliance.assignment = null;
        found.appliance.eta = 0;
      }
    }

    log(`${r.label} released from incident; returning to base and available for immediate re-tasking.`);
    renderStations();
    renderIncidents();
    return;
  }

  // Ground specialist resources keep the existing instant-release behaviour.
  r.status = 'Released';
  if (r.marker && map.hasLayer(r.marker)) map.removeLayer(r.marker);

  const linkedId = r.plantApplianceId || r.aircraftApplianceId;
  if (linkedId) {
    const found = allAppliances().find(x => x.appliance.id === linkedId);
    if (found) {
      found.appliance.status = 'Available';
      found.appliance.assignment = null;
      found.appliance.eta = 0;
    }
  }

  log(`${r.label} released.`);
  renderStations();
  renderIncidents();
}

function updateSpecialResources(dtMinutes) {
  state.specialResources.forEach(r => {
    if (r.status === 'Released') return;

    // Return flights must continue even after the incident itself has closed.
    if (r.kind === 'air' && r.status === 'Returning') {
      r.returnEta = Math.max(0, (Number(r.returnEta) || 0) - dtMinutes);
      const total = Math.max(0.001, Number(r.returnTotalEta) || 0.001);
      const progress = Math.min(1, Math.max(0, 1 - r.returnEta / total));
      const from = r.returnStart || r.marker.getLatLng();
      const to = r.returnTarget || r.start;

      const point = L.latLng(
        from.lat + (to.lat - from.lat) * progress,
        from.lng + (to.lng - from.lng) * progress
      );

      if (r.marker) {
        r.marker.setLatLng(point);
        r.marker.setTooltipContent(`${r.label} • returning ${Math.max(0, Math.ceil(r.returnEta))} min`);
      }

      if (r.aircraftApplianceId) {
        const found = allAppliances().find(x => x.appliance.id === r.aircraftApplianceId);
        if (found) found.appliance.eta = r.returnEta;
      }

      if (r.returnEta <= 0) {
        if (r.marker && map.hasLayer(r.marker)) map.removeLayer(r.marker);
        r.status = 'Released';

        if (r.aircraftApplianceId) {
          const found = allAppliances().find(x => x.appliance.id === r.aircraftApplianceId);
          if (found && found.appliance.status === 'Available') {
            found.appliance.assignment = null;
            found.appliance.eta = 0;
          }
        }

        log(`${r.label} returned to base.`);
        renderStations();
        renderIncidents();
      }
      return;
    }

    const fire = state.fires.find(f => f.id === r.fireId);
    if (!fire) return;

    if (r.status === 'Inbound') {
      r.eta -= dtMinutes;
      const progress = Math.min(1, Math.max(0, 1 - r.eta / r.totalEta));
      const point = r.kind === 'plant' && r.routeCoords
        ? routePointAt(r.routeCoords, progress)
        : L.latLng(
            r.start.lat + (fire.ignition.lat - r.start.lat) * progress,
            r.start.lng + (fire.ignition.lng - r.start.lng) * progress
          );
      r.marker.setLatLng(point);
      r.marker.setTooltipContent(`${r.label} • ${Math.max(0,Math.ceil(r.eta))} min`);

      if (r.eta <= 0) {
        if (r.kind === 'air') {
          r.status = 'On Task';
          r.cycleTimer = 2.5;
          r.marker.setLatLng(fire.ignition);

          if (r.aircraftApplianceId) {
            const found = allAppliances().find(x => x.appliance.id === r.aircraftApplianceId);
            if (found) {
              found.appliance.status = 'On Task';
              found.appliance.eta = 0;
            }
          }

          log(`${r.label} commencing drops on ${fire.name}.`);
        } else {
          r.status = fire.machineSupervisor ? 'Working' : 'Awaiting Supervisor';
          r.marker.setLatLng(fire.ignition);
          if (r.routeLine && map.hasLayer(r.routeLine)) map.removeLayer(r.routeLine);

          if (r.plantApplianceId) {
            const found = allAppliances().find(x => x.appliance.id === r.plantApplianceId);
            if (found) {
              found.appliance.status = r.status;
              found.appliance.eta = 0;
            }
          }

          log(`${r.label} arrived at ${fire.name}${fire.machineSupervisor ? ' and commenced mineral-earth break construction.' : '; awaiting Machine Supervisor.'}`);
        }
      }
    } else if (r.kind === 'air' && r.status === 'On Task') {
      r.orbitPhase = (r.orbitPhase || 0) + dtMinutes * 0.55;
      const orbitRadius = Math.max(450, Math.min(1200, 350 + Math.sqrt(Math.max(.1, fire.areaHa) * 10000 / Math.PI) * 2.0));
      const orbitPoint = offsetPoint(
        fire.ignition,
        Math.cos(r.orbitPhase) * orbitRadius,
        Math.sin(r.orbitPhase) * orbitRadius
      );
      if (r.marker) {
        r.marker.setLatLng(orbitPoint);
        r.marker.setTooltipContent(`${r.label} • working ${fire.name}`);
      }

      r.cycleTimer -= dtMinutes;
      if (r.cycleTimer <= 0) {
        const containmentGain = 3.0 * r.effect;
        const controlGain = 1.5 * r.effect;

        fire.containment = Math.min(100, fire.containment + containmentGain);
        fire.controlProgress = Math.min(100, fire.controlProgress + controlGain);
        fire.airDropHoldTimer = Math.max(Number(fire.airDropHoldTimer) || 0, 8);
        fire.airDropHoldStrength = Math.max(Number(fire.airDropHoldStrength) || 0, 0.28 * r.effect);

        log(`${r.label} completed a drop on ${fire.name}; +${containmentGain.toFixed(1)}% containment, +${controlGain.toFixed(1)}% control.`);
        log(`${r.label} departing to reload.`);
        r.status = 'Reloading';
        r.cycleTimer = r.cycle;
      }
    } else if (r.kind === 'air' && r.status === 'Reloading') {
      r.cycleTimer -= dtMinutes;
      if (r.cycleTimer <= 0) {
        r.status = 'On Task';
        r.cycleTimer = 2.5;
        log(`${r.label} returned to ${fire.name} for another drop.`);
      }
    } else if (r.kind === 'plant') {
      if (r.status === 'Awaiting Supervisor' && fire.machineSupervisor) {
        r.status = 'Working';
        log(`${r.label} commenced containment line construction.`);
      }
      if (r.status === 'Working') {
        const buildRate = r.type === 'DOZER' ? 1.35 : 0.85;
        fire.mineralBreakProgress = Math.min(
          100,
          (Number(fire.mineralBreakProgress) || 0) + buildRate * dtMinutes
        );

        // Fresh mineral-earth line also improves reported containment.
        fire.containment = Math.min(
          100,
          fire.containment + buildRate * 0.10 * dtMinutes
        );

        updateMineralBreakLine(fire);

        if (fire.mineralBreakProgress >= 100 && !fire.mineralBreakCompleteAnnounced) {
          fire.mineralBreakCompleteAnnounced = true;
          log(`${fire.name}: mineral-earth containment break completed; forward spread is checked at the constructed line.`);
        }
      }
    }
  });
}

function setMachineSupervisor(fireId) {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire) return;
  fire.machineSupervisor = !fire.machineSupervisor;
  log(`${fire.name}: Machine Supervisor ${fire.machineSupervisor ? 'assigned' : 'stood down'}.`);
  renderIncidents();
}


function updateMineralBreakLine(fire) {
  const radius = Math.max(
    140,
    Math.sqrt(Math.max(.1, fire.areaHa) * 10000 / Math.PI) * 1.55
  );
  const progress = Math.max(0, Math.min(100, Number(fire.mineralBreakProgress) || 0)) / 100;
  const count = Math.max(2, Math.floor(96 * progress));
  const points = [];

  for (let i = 0; i <= count; i++) {
    const th = -Math.PI/2 + (Math.PI * 2) * (i / 96);
    const p = offsetPoint(
      fire.ignition,
      Math.cos(th) * radius,
      Math.sin(th) * radius
    );
    points.push([p.lat,p.lng]);
  }

  if (!fire.mineralBreakLine) {
    fire.mineralBreakLine = L.polyline(points, {
      color:'#8b6f47',
      weight:6,
      opacity:.95
    }).addTo(map);
  } else {
    fire.mineralBreakLine.setLatLngs(points);
  }
}

function updateContainmentLine(fire) {
  const radius = Math.max(120, Math.sqrt(Math.max(.1,fire.areaHa) * 10000 / Math.PI) * 1.45);
  const points = [];
  const completed = Math.max(0, Math.min(100, fire.containment)) / 100;
  const count = Math.max(2, Math.floor(80 * completed));
  for (let i=0;i<=count;i++) {
    const th = -Math.PI/2 + (Math.PI*2) * (i/80);
    const p = offsetPoint(fire.ignition, Math.cos(th)*radius, Math.sin(th)*radius);
    points.push([p.lat,p.lng]);
  }
  if (!fire.containmentLine) {
    fire.containmentLine = L.polyline(points, {color:'#111', weight:5, opacity:.85, dashArray:'8 4'}).addTo(map);
  } else {
    fire.containmentLine.setLatLngs(points);
  }
}


async function releaseApplianceFromIncident(fireId, applianceId, reason='Released') {
  const fire = state.fires.find(f => f.id === fireId);
  const found = allAppliances().find(x => x.appliance.id === applianceId);
  if (!fire || !found) return;

  const asn = fire.assignments.find(a => a.applianceId === applianceId);
  if (!asn) return;

  if (asn.routeLine && map.hasLayer(asn.routeLine)) map.removeLayer(asn.routeLine);
  if (asn.firegroundLine && map.hasLayer(asn.firegroundLine)) map.removeLayer(asn.firegroundLine);

  const currentPos = asn.marker
    ? asn.marker.getLatLng()
    : (fire.ignition || fire.center);

  found.appliance.status = 'Available';
  found.appliance.assignment = null;
  found.appliance.task = 'None';

  // Keep the blip alive and return it to its home station.
  const marker = asn.marker || L.marker(currentPos, {
    icon: found.appliance.code === 'Rescue Helicopter'
      ? specialIcon('air')
      : L.divIcon({
          className:'',
          html:'<div class="appliance-blip"></div>',
          iconSize:[16,16],
          iconAnchor:[8,8]
        }),
    zIndexOffset:900
  }).addTo(map);

  marker.setTooltipContent(`${found.appliance.callsign} • Returning`);

  // Remove it from the active fireground assignment list immediately.
  fire.assignments = fire.assignments.filter(a => a.applianceId !== applianceId);

  let route;
  const isRescueAircraft = found.appliance.code === 'Rescue Helicopter';

  if (isRescueAircraft) {
    const distanceKm = haversineKm(currentPos, found.station.latlng);
    route = {
      coords:[currentPos, found.station.latlng],
      distanceKm,
      usedFallback:false
    };
  } else {
    try {
      route = await getRoadRoute(currentPos, found.station.latlng);
    } catch (err) {
      route = {
        coords:[currentPos, found.station.latlng],
        roadCoords:[],
        snappedEnd:found.station.latlng,
        roadDistanceKm:haversineKm(currentPos, found.station.latlng),
        firegroundKm:0,
        stationAccessKm:0,
        distanceKm:haversineKm(currentPos, found.station.latlng),
        usedFallback:true
      };
    }
  }

  const returnKmh = isRescueAircraft
    ? (Number(found.appliance.airSpeed) || 250)
    : (found.appliance.code === '12.2' ? 80 : 100);
  const eta = Math.max(isRescueAircraft ? 0.5 : 1, (route.distanceKm / returnKmh) * 60);

  found.appliance.eta = 0;

  let routeLine = null;
  if (route.coords && route.coords.length > 1) {
    routeLine = L.polyline(route.coords, {
      color:'#7f8c8d',
      weight:2,
      dashArray:'5 6',
      opacity:.65
    }).addTo(map);
  }

  state.returningAppliances = state.returningAppliances || [];
  state.returningAppliances.push({
    applianceId,
    callsign:found.appliance.callsign,
    stationId:found.station.id,
    eta,
    totalEta:eta,
    routeCoords:route.coords,
    marker,
    routeLine,
    currentPos:L.latLng(currentPos.lat, currentPos.lng)
  });

  log(`${found.appliance.callsign} released from ${fire.name} (${reason}), available for further turnout, and returning to ${found.station.name}.`);
  renderStations();
  renderIncidents();
}

function releaseAllIncidentAppliances(fireId, reason='Incident complete') {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire) return;

  const ids = fire.assignments.map(a => a.applianceId);
  ids.forEach(id => releaseApplianceFromIncident(fireId, id, reason));
}


function bulkWaterSourcesForIncident(fire) {
  if (!fire) return [];
  return fire.assignments
    .map(asn => {
      const found = allAppliances().find(x => x.appliance.id === asn.applianceId);
      return found ? {asn, appliance:found.appliance} : null;
    })
    .filter(x =>
      x &&
      x.appliance.code === '12.2' &&
      x.asn.status === 'At ICP' &&
      x.appliance.currentWater > 0
    );
}


function applianceAgency(found) {
  const type = found?.station?.type || 'BUSHFIRE';
  if (type === 'WAPOL') return 'WAPOL';
  if (type === 'SJA') return 'SJA';
  if (found?.appliance?.code === 'Rescue Helicopter') return 'SJA';
  return 'FIRE';
}


function incidentWorkflowPhases(incident) {
  const t = incident.incidentType;

  if (t === 'Disturbance') return [
    [{id:'pol_scene', agency:'WAPOL', task:'Scene Control', duration:1.5}],
    [{id:'pol_separate', agency:'WAPOL', task:'Separate Parties', duration:2.0}],
    [{id:'pol_investigate', agency:'WAPOL', task:'Investigation', duration:3.0}],
    [{id:'pol_transport', agency:'WAPOL', task:'Arrest / Transport', duration:2.0}],
    [{id:'pol_clear', agency:'WAPOL', task:'Clear Scene', duration:1.0}]
  ];

  if (t === 'Welfare Check') return [
    [{id:'wel_check', agency:'WAPOL', task:'Welfare Check', duration:1.5}],
    [{id:'wel_locate', agency:'WAPOL', task:'Locate Person', duration:2.5}],
    [{id:'wel_assess', agency:'WAPOL', task:'Scene Assessment', duration:2.0}],
    [{id:'wel_escort', agency:'WAPOL', task:'Transport / Escort', duration:2.0}],
    [{id:'wel_clear', agency:'WAPOL', task:'Clear Scene', duration:1.0}]
  ];

  if (t === 'Road Crash Rescue' || t === 'Traffic Crash') return [
    [
      {id:'rcr_pol_scene', agency:'WAPOL', task:'Scene Control', duration:1.5},
      {id:'rcr_fire_safe', agency:'FIRE', task:'Scene Safety', duration:1.5},
      {id:'rcr_sja_triage', agency:'SJA', task:'Triage', duration:1.5}
    ],
    [
      {id:'rcr_pol_traffic', agency:'WAPOL', task:'Traffic Control', duration:2.0},
      {id:'rcr_pol_close', agency:'WAPOL', task:'Road Closure', duration:1.5},
      {id:'rcr_fire_stab', agency:'FIRE', task:'Stabilise Vehicle', duration:2.5},
      {id:'rcr_fire_protect', agency:'FIRE', task:'Fire Protection', duration:2.0},
      {id:'rcr_sja_treat', agency:'SJA', task:'Treat Patient', duration:3.0}
    ],
    [
      {id:'rcr_fire_extricate', agency:'FIRE', task:'Extrication', duration:4.0},
      {id:'rcr_sja_standby', agency:'SJA', task:'Extrication Standby', duration:3.0}
    ],
    [
      {id:'rcr_pol_investigate', agency:'WAPOL', task:'Investigation', duration:3.0},
      {id:'rcr_pol_witness', agency:'WAPOL', task:'Witness Statements', duration:2.5},
      {id:'rcr_fire_debris', agency:'FIRE', task:'Debris Cleanup', duration:2.0},
      {id:'rcr_sja_prepare', agency:'SJA', task:'Prepare Transport', duration:2.0}
    ],
    [
      {id:'rcr_sja_transport', agency:'SJA', task:'Transport Patient', duration:2.0},
      {id:'rcr_pol_clear', agency:'WAPOL', task:'Clear Scene', duration:1.0}
    ]
  ];

  if (t === 'Medical Emergency') return [
    [{id:'med_triage', agency:'SJA', task:'Triage', duration:1.5}],
    [{id:'med_treat', agency:'SJA', task:'Treat Patient', duration:3.0}],
    [{id:'med_prepare', agency:'SJA', task:'Prepare Transport', duration:1.5}],
    [{id:'med_transport', agency:'SJA', task:'Transport Patient', duration:2.0}]
  ];

  if (t === 'Cardiac Arrest') return [
    [{id:'ca_triage', agency:'SJA', task:'Triage', duration:1.0}],
    [{id:'ca_resus', agency:'SJA', task:'Resuscitation', duration:4.0}],
    [{id:'ca_treat', agency:'SJA', task:'Treat Patient', duration:3.0}],
    [{id:'ca_prepare', agency:'SJA', task:'Prepare Transport', duration:1.5}],
    [{id:'ca_transport', agency:'SJA', task:'Transport Patient', duration:2.0}]
  ];

  if (t === 'Hazmat Incident') return [
    [{id:'hz_hot', agency:'FIRE', task:'Hot Zone', duration:2.0}],
    [
      {id:'hz_contain', agency:'FIRE', task:'Contain Spill', duration:4.0},
      {id:'hz_monitor', agency:'FIRE', task:'Monitoring', duration:3.0}
    ],
    [{id:'hz_decon', agency:'FIRE', task:'Decontamination', duration:3.0}],
    [{id:'hz_fire', agency:'FIRE', task:'Fire Protection', duration:2.0}]
  ];

  if (t === 'Rescue Incident') return [
    [
      {id:'res_sector', agency:'FIRE', task:'Rescue Sector', duration:1.5},
      {id:'res_safety', agency:'FIRE', task:'Safety Officer', duration:1.5}
    ],
    [{id:'res_rig', agency:'FIRE', task:'Rig Rescue', duration:3.0}],
    [{id:'res_access', agency:'FIRE', task:'Patient Access', duration:3.0}]
  ];

  if (t === 'Automatic Fire Alarm') return [
    [{id:'afa_investigate', agency:'FIRE', task:'Investigate Alarm', duration:2.0}],
    [{id:'afa_check', agency:'FIRE', task:'Building Check', duration:2.5}],
    [{id:'afa_reset', agency:'FIRE', task:'Reset / Isolate', duration:1.5}]
  ];

  if (t === 'Building Fire' || t === 'Structure Fire') return [
    [{id:'bf_safe', agency:'FIRE', task:'Scene Safety', duration:1.5}],
    [
      {id:'bf_attack', agency:'FIRE', task:'Fire Attack', duration:4.0},
      {id:'bf_search', agency:'FIRE', task:'Search / Rescue', duration:3.5}
    ],
    [{id:'bf_vent', agency:'FIRE', task:'Ventilation', duration:2.5}],
    [{id:'bf_overhaul', agency:'FIRE', task:'Overhaul', duration:3.0}],
    [{id:'bf_clear', agency:'FIRE', task:'Clear Scene', duration:1.0}]
  ];

  if (t === 'Vehicle Fire') return [
    [{id:'vf_safe', agency:'FIRE', task:'Scene Safety', duration:1.0}],
    [{id:'vf_attack', agency:'FIRE', task:'Fire Attack', duration:3.0}],
    [{id:'vf_spill', agency:'FIRE', task:'Spill Control', duration:2.0}],
    [{id:'vf_overhaul', agency:'FIRE', task:'Overhaul', duration:2.0}],
    [{id:'vf_clear', agency:'FIRE', task:'Clear Scene', duration:1.0}]
  ];

  return [];
}

function ensureWorkflowState(incident) {
  incident.workflowProgress = incident.workflowProgress || {};
  incident.workflowPhase = Number.isFinite(Number(incident.workflowPhase))
    ? Number(incident.workflowPhase)
    : 0;
}

function workflowTaskState(incident, agency, task) {
  if (isWildfireIncident(incident)) return 'wildfire';

  ensureWorkflowState(incident);
  const phases = incidentWorkflowPhases(incident);
  let phaseIndex = -1;
  let step = null;

  phases.forEach((phase, idx) => {
    phase.forEach(s => {
      if (s.agency === agency && s.task === task && phaseIndex < 0) {
        phaseIndex = idx;
        step = s;
      }
    });
  });

  if (!step) return 'neutral';
  if ((incident.workflowProgress[step.id] || 0) >= 100) return 'complete';
  if (phaseIndex === incident.workflowPhase) return 'current';
  if (phaseIndex < incident.workflowPhase) return 'complete';
  return 'future';
}

function workflowHints(incident) {
  if (isWildfireIncident(incident)) {
    if (incident.containment < 100) {
      return ['Attack the head/flanks and maintain water supply until containment reaches 100%.'];
    }
    if (incident.controlProgress < 100) {
      return ['Containment is holding. Blackout and patrol work should now build control.'];
    }
    return ['Fire is controlled. Continue blackout/mop-up until the incident is safe.'];
  }

  ensureWorkflowState(incident);
  const phases = incidentWorkflowPhases(incident);
  const phase = phases[incident.workflowPhase] || [];
  return phase.map(s => `${agencyLabel(s.agency)}: ${s.task}`);
}

function rescueCapable(found) {
  if (!found) return false;
  const type = found.station.type;
  const code = found.appliance.code;

  if (type === 'SES' && code === 'SES Rescue') return true;
  if (type === 'VFES') return true;
  if (type === 'VFRS' || type === 'CFRS') return true;
  return ['HSR','UPHR','RCR Tender'].includes(code);
}

function arrivedIncidentResources(incident) {
  return incident.assignments
    .filter(a => ['On Scene','At ICP'].includes(a.status))
    .map(a => allAppliances().find(x => x.appliance.id === a.applianceId))
    .filter(Boolean);
}

function wildfireAlarmLabel(level) {
  return ['Initial Response','1st Alarm','2nd Alarm','3rd Alarm'][Math.max(0, Math.min(3, Number(level) || 0))];
}

function incidentMinimumRequirements(incident) {
  const arrived = arrivedIncidentResources(incident);
  const byAgency = agency => arrived.filter(x => applianceAgency(x) === agency);
  const t = incident.incidentType;
  const reqs = [];

  const add = (label, met, detail='') => reqs.push({label, met, detail});

  if (isWildfireIncident(incident)) {
    const level = Math.max(0, Math.min(3, Number(incident.alarmLevel) || 0));
    const unitTargets = [2,4,6,8];
    const stationTargets = [2,3,4,5];
    const fireUnits = byAgency('FIRE').filter(x => !['SES'].includes(x.station.type));
    const distinctStations = new Set(fireUnits.map(x => x.station.id)).size;

    add(
      `${unitTargets[level]} firefighting appliances`,
      fireUnits.length >= unitTargets[level],
      `${fireUnits.length}/${unitTargets[level]} on scene`
    );
    add(
      `${stationTargets[level]} brigades/stations represented`,
      distinctStations >= stationTargets[level],
      `${distinctStations}/${stationTargets[level]} represented`
    );
    return reqs;
  }

  if (t === 'Road Crash Rescue' || t === 'Traffic Crash') {
    const rescueResponse = byAgency('FIRE').filter(x =>
      ['VFRS','CFRS','VFES'].includes(x.station.type) ||
      (x.station.type === 'SES' && x.appliance.code === 'SES Rescue')
    );

    add('1 police unit', byAgency('WAPOL').length >= 1, `${byAgency('WAPOL').length}/1`);
    add('1 ambulance', byAgency('SJA').length >= 1, `${byAgency('SJA').length}/1`);
    add(
      '2 rescue response units — FRS/VFES and/or SES Rescue',
      rescueResponse.length >= 2,
      `${rescueResponse.length}/2`
    );
    return reqs;
  }

  if (t === 'Disturbance') {
    add('2 police units', byAgency('WAPOL').length >= 2, `${byAgency('WAPOL').length}/2`);
    return reqs;
  }

  if (t === 'Welfare Check') {
    add('1 police unit', byAgency('WAPOL').length >= 1, `${byAgency('WAPOL').length}/1`);
    return reqs;
  }

  if (t === 'Medical Emergency' || t === 'Cardiac Arrest') {
    add('1 ambulance/paramedic unit', byAgency('SJA').length >= 1, `${byAgency('SJA').length}/1`);
    return reqs;
  }

  if (t === 'Hazmat Incident') {
    add('2 fire/rescue units', byAgency('FIRE').length >= 2, `${byAgency('FIRE').length}/2`);
    return reqs;
  }

  if (t === 'Rescue Incident') {
    const fireRescue = byAgency('FIRE').filter(x => ['VFRS','CFRS','VFES','SES'].includes(x.station.type));
    add('2 rescue units', fireRescue.length >= 2, `${fireRescue.length}/2`);
    add('At least 1 rescue-capable unit', fireRescue.some(rescueCapable), fireRescue.some(rescueCapable) ? 'met' : 'not met');
    return reqs;
  }

  if (t === 'Automatic Fire Alarm') {
    add('1 fire appliance', byAgency('FIRE').length >= 1, `${byAgency('FIRE').length}/1`);
    return reqs;
  }

  if (t === 'Building Fire' || t === 'Structure Fire') {
    add('2 fire appliances', byAgency('FIRE').length >= 2, `${byAgency('FIRE').length}/2`);
    return reqs;
  }

  if (t === 'Vehicle Fire') {
    add('1 fire appliance', byAgency('FIRE').length >= 1, `${byAgency('FIRE').length}/1`);
    return reqs;
  }

  return reqs;
}

function minimumRequirementsMet(incident) {
  const reqs = incidentMinimumRequirements(incident);
  return !reqs.length || reqs.every(r => r.met);
}

function setIncidentAlarm(fireId, level) {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire || !isWildfireIncident(fire)) return;
  fire.alarmLevel = Math.max(0, Math.min(3, Number(level) || 0));
  log(`${fire.name}: response level set to ${wildfireAlarmLabel(fire.alarmLevel)}.`);
  renderIncidents();
}

function taskOptionsFor(found, incident) {
  const agency = applianceAgency(found);

  if (agency === 'WAPOL') {
    if (incident.incidentType === 'Road Crash Rescue' || incident.incidentType === 'Traffic Crash') {
      return ['Scene Control','Traffic Control','Road Closure','Investigation','Witness Statements','Clear Scene','None'];
    }
    if (incident.incidentType === 'Welfare Check') {
      return ['Welfare Check','Locate Person','Scene Assessment','Transport / Escort','Clear Scene','None'];
    }
    if (incident.incidentType === 'Disturbance') {
      return ['Scene Control','Separate Parties','Investigation','Arrest / Transport','Clear Scene','None'];
    }
    return ['Scene Control','Traffic Control','Investigation','Search','Arrest / Transport','Clear Scene','None'];
  }

  if (agency === 'SJA') {
    if (incident.incidentType === 'Cardiac Arrest') {
      return ['Triage','Resuscitation','Treat Patient','Prepare Transport','Transport Patient','Standby','None'];
    }
    if (incident.incidentType === 'Road Crash Rescue' || incident.incidentType === 'Traffic Crash') {
      return ['Triage','Treat Patient','Extrication Standby','Prepare Transport','Transport Patient','Standby','None'];
    }
    return ['Triage','Treat Patient','Prepare Transport','Transport Patient','Standby','None'];
  }

  // Fire / rescue agencies
  if (incident.incidentType === 'Road Crash Rescue' || incident.incidentType === 'Traffic Crash') {
    return ['Scene Safety','Stabilise Vehicle','Extrication','Fire Protection','Debris Cleanup','Standby','None'];
  }
  if (incident.incidentType === 'Hazmat Incident') {
    return ['Hot Zone','Decontamination','Contain Spill','Monitoring','Fire Protection','Standby','None'];
  }
  if (incident.incidentType === 'Rescue Incident') {
    return ['Rescue Sector','Rig Rescue','Patient Access','Safety Officer','Standby','None'];
  }
  if (incident.incidentType === 'Automatic Fire Alarm') {
    return ['Investigate Alarm','Building Check','Reset / Isolate','Standby','None'];
  }
  if (incident.incidentType === 'Building Fire' || incident.incidentType === 'Structure Fire') {
    return ['Scene Safety','Fire Attack','Search / Rescue','Ventilation','Overhaul','Clear Scene','Standby','None'];
  }
  if (incident.incidentType === 'Vehicle Fire') {
    return ['Scene Safety','Fire Attack','Spill Control','Overhaul','Clear Scene','Standby','None'];
  }

  return ['Head Attack','Left Flank','Right Flank','General Attack','Property Protection','Blackout','Refill','None'];
}

function isWildfireIncident(incident) {
  return ['Vegetation Fire','Escaped Burn-off','Lightning Start'].includes(incident.incidentType);
}

function incidentAgencyNeeds(incident) {
  const t = incident.incidentType;
  if (t === 'Road Crash Rescue' || t === 'Traffic Crash') return ['FIRE','WAPOL','SJA'];
  if (t === 'Medical Emergency' || t === 'Cardiac Arrest') return ['SJA'];
  if (t === 'Disturbance' || t === 'Welfare Check') return ['WAPOL'];
  if (
    t === 'Hazmat Incident' ||
    t === 'Rescue Incident' ||
    t === 'Automatic Fire Alarm' ||
    t === 'Building Fire' ||
    t === 'Structure Fire' ||
    t === 'Vehicle Fire'
  ) return ['FIRE'];
  return ['FIRE'];
}

function agencyLabel(agency) {
  if (agency === 'WAPOL') return 'WAPOL';
  if (agency === 'SJA') return 'St John WA';
  return 'Fire / Rescue';
}

function agencyIncidentCommand(fireId, agency, command) {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire) return;

  fire.agencyCommands = fire.agencyCommands || {};
  fire.agencyCommands[agency] = command;

  const names = {
    FIRE: 'Fire / Rescue',
    WAPOL: 'WAPOL',
    SJA: 'St John WA'
  };

  log(`${fire.name}: ${names[agency] || agency} command set to ${command}.`);
  renderIncidents();
}

function setTask(fireId, applianceId, task) {
  const fire = state.fires.find(f => f.id === fireId);
  const found = allAppliances().find(x => x.appliance.id === applianceId);
  const asn = fire && fire.assignments.find(a => a.applianceId === applianceId);
  if (!fire || !found || !asn) return;

  if (found.appliance.code === '12.2') {
    found.appliance.task = 'Water Supply';
    log(`${found.appliance.callsign} remains staged at the ICP as a bulk-water source; 12.2 appliances cannot be assigned active firefighting tasks.`);
    renderStations();
    renderIncidents();
    return;
  }

  if (!['On Scene','At ICP'].includes(found.appliance.status)) return;

  const allowedTasks = taskOptionsFor(found, fire);
  if (!allowedTasks.includes(task)) return;

  found.appliance.task = task;

  const workflowState = task !== 'None'
    ? workflowTaskState(fire, applianceAgency(found), task)
    : 'neutral';

  if (workflowState === 'future') {
    const next = workflowHints(fire).join(' • ');
    log(`${found.appliance.callsign}: ${task} assigned, but prerequisites are incomplete. Next: ${next}.`);
  } else if (workflowState === 'complete') {
    log(`${found.appliance.callsign}: ${task} is already complete for this incident.`);
  }

  if (asn.status === 'At ICP' && task !== 'None') {
    asn.status = 'On Scene';
    found.appliance.status = 'On Scene';
    asn.phase = Math.random() * Math.PI * 2;

    if (asn.marker) {
      const p = offsetPoint(fire.ignition, 45, 25);
      asn.marker.setLatLng(p);
      asn.marker.setTooltipContent(`${asn.callsign} • ${task}`);
    }

    log(`${found.appliance.callsign} tasked from ICP: ${task}.`);
  } else {
    log(`${found.appliance.callsign} assigned: ${task}.`);
  }

  renderStations();
  renderIncidents();
}

function establishSectors(fireId) {
  const fire = state.fires.find(f => f.id === fireId);
  if (!fire) return;
  fire.sectorsEstablished = true;
  log(`${fire.name}: Head, Left Flank and Right Flank sectors established.`);
  renderIncidents();
}


function updateReturningAppliances(dtMinutes) {
  state.returningAppliances = state.returningAppliances || [];

  state.returningAppliances.forEach(ret => {
    const found = allAppliances().find(x => x.appliance.id === ret.applianceId);
    if (!found) {
      ret.done = true;
      return;
    }

    ret.eta -= dtMinutes;

    const progress = Math.min(1, Math.max(0, 1 - (ret.eta / ret.totalEta)));
    const point = routePointAt(ret.routeCoords, progress);
    if (point) ret.currentPos = L.latLng(point.lat, point.lng);

    if (ret.marker && point) {
      ret.marker.setLatLng(point);
      ret.marker.setTooltipContent(
        `${ret.callsign} • Returning • available for turnout • ${Math.max(0, Math.ceil(ret.eta))} min to station`
      );
    }

    if (ret.eta <= 0) {
      if (ret.marker && map.hasLayer(ret.marker)) map.removeLayer(ret.marker);
      if (ret.routeLine && map.hasLayer(ret.routeLine)) map.removeLayer(ret.routeLine);

      // Appliance is already dispatchable while returning. On station arrival,
      // automatically replenish its tank to full.
      found.appliance.status = 'Available';
      found.appliance.assignment = null;
      found.appliance.eta = 0;
      found.appliance.task = 'None';
      found.appliance.currentWater = found.appliance.maxWater;

      log(`${ret.callsign} returned to ${found.station.name}, refilled to ${found.appliance.maxWater.toLocaleString()} L, and remains available.`);
      ret.done = true;
    }
  });

  state.returningAppliances = state.returningAppliances.filter(r => !r.done);
}
