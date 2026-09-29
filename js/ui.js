/* Rendering for stations, incidents, warnings and interactive UI lists. */
function renderStations() {
  const listedStations = state.stations.filter(s => !s.hiddenSystemBase);

  if (els.stationsToggleBtn) {
    els.stationsToggleBtn.textContent = state.stationsCollapsed ? 'Show List' : 'Hide List';
  }

  if (state.stationsCollapsed) {
    els.stationsList.innerHTML = `<div class="mini">${listedStations.length} station${listedStations.length === 1 ? '' : 's'} hidden.</div>`;
    return;
  }

  if (!listedStations.length) {
    els.stationsList.textContent = 'No stations placed. Use Place Station, then click the map.';
    return;
  }

  const q = String(state.stationSearch || '').trim().toLowerCase();
  const visible = listedStations.filter(s => {
    if (!q) return true;
    const haystack = [
      s.name,
      stationTypeLabel(s.type || 'BUSHFIRE'),
      ...s.appliances.flatMap(a => [a.callsign, a.code, a.role])
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });

  if (!visible.length) {
    els.stationsList.innerHTML = '<div class="mini">No stations/appliances match that search.</div>';
    return;
  }

  els.stationsList.innerHTML = visible.map(s =>
    `<div class="card">
      <div class="station-head">
        <div>
          <strong>${s.name}</strong>
          <div class="mini">${stationTypeLabel(s.type || 'BUSHFIRE')}</div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
          <button class="small-btn edit-station-btn" data-station="${s.id}" style="width:auto">Edit</button>
          <button class="small-btn delete-station-btn danger" data-station="${s.id}" style="width:auto">Delete</button>
        </div>
      </div>
      ${s.appliances.length ? s.appliances.map(a => {
        const ret = (state.returningAppliances || []).find(r => r.applianceId === a.id);
        const airReturn = (state.specialResources || []).find(r =>
          r.kind === 'air' &&
          r.aircraftApplianceId === a.id &&
          r.status === 'Returning'
        );
        return `<div class="resource-row">
          <div style="min-width:0">
            <b>${a.callsign}</b>
            <div class="resource-meta">${a.role}` +
            `${a.maxWater > 0 ? ` • ${Math.round(a.currentWater).toLocaleString()}/${a.maxWater.toLocaleString()} L` : ''}` +
            ` • ${a.drive}` +
            `${a.status === 'En Route' ? ` • ETA ${Math.ceil(a.eta)} min` : ''}` +
            `${ret ? ` • Returning: ${Math.max(0, Math.ceil(ret.eta))} min to station` : ''}` +
            `${airReturn ? ` • Returning to base: ${Math.max(0, Math.ceil(airReturn.returnEta || 0))} min • available to divert` : ''}` +
            `${a.status === 'On Scene' && a.task !== 'None' ? ` • ${a.task}` : ''}</div>
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            <span class="badge ${a.status === 'En Route' ? 'status-enroute' : a.status === 'On Scene' ? 'status-onscene' : ''}">${a.status}</span>
            <button class="small-btn rename-appliance-btn" data-appliance="${a.id}" style="width:auto">Rename</button>
          </div>
        </div>`;
      }).join('') : '<div class="mini">No appliances assigned.</div>'}
    </div>`
  ).join('');

  document.querySelectorAll('.edit-station-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      openStationEditModal(Number(btn.dataset.station));
    };
  });

  document.querySelectorAll('.delete-station-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      deleteStation(Number(btn.dataset.station));
    };
  });

  document.querySelectorAll('.rename-appliance-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      renameAppliance(btn.dataset.appliance);
    };
  });
}

function renderIncidents() {
  const focusedSearch = document.activeElement?.classList?.contains('incident-resource-search')
    ? {
        fireId: document.activeElement.dataset.fire,
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd
      }
    : null;

  if (!state.fires.length) {
    els.incidentsList.innerHTML = 'No active incidents.';
    return;
  }

  els.incidentsList.innerHTML = state.fires.map(f => {
    if (f.marker) {
      f.marker.setPopupContent(incidentPopupHtml(f));
    }

    const selected = state.selectedIncidentId === f.id;
    const collapsed = state.incidentCollapsed[f.id] === undefined
      ? !selected
      : !!state.incidentCollapsed[f.id];

    const available = allAppliances().filter(x =>
      x.appliance.status === 'Available' &&
      x.station.type !== 'DBCA' &&
      (x.station.type !== 'AIRBASE' || x.appliance.code === 'Rescue Helicopter')
    );

    const assignments = f.assignments.length
      ? f.assignments.map(a => {
          const found = allAppliances().find(x => x.appliance.id === a.applianceId);
          const appliance = found && found.appliance;
          const taskKey = `${f.id}:${a.applianceId}`;
          const taskPanelOpen = !!state.assignmentTaskOpen[taskKey];

          const taskControls = appliance && a.status === 'En Route'
            ? `<div class="incident-actions">
                <button class="small-btn standdown-appliance-btn" data-fire="${f.id}" data-appliance="${a.applianceId}">Stand Down</button>
              </div>`
            : appliance && (a.status === 'On Scene' || a.status === 'At ICP')
              ? appliance.code === '12.2'
                ? `<div class="incident-actions">
                    <span class="badge">Water Supply Only</span>
                    <button class="small-btn release-appliance-btn" data-fire="${f.id}" data-appliance="${a.applianceId}">Release</button>
                  </div>`
                : `<div class="incident-actions">
                    <button class="small-btn task-toggle-btn" data-key="${taskKey}">
                      ${taskPanelOpen ? 'Hide Tasks' : 'Tasks'}
                    </button>
                    <button class="small-btn release-appliance-btn" data-fire="${f.id}" data-appliance="${a.applianceId}">Release</button>
                  </div>
                  ${taskPanelOpen ? `<div class="incident-actions" style="margin-top:6px">
                    ${taskOptionsFor(found, f).map(task => {
                      const agency = applianceAgency(found);
                      const stateName = task === 'None' || task === 'Standby'
                        ? 'neutral'
                        : workflowTaskState(f, agency, task);
                      const prefix = stateName === 'current' ? '▶ ' : stateName === 'complete' ? '✓ ' : '';
                      const title = stateName === 'future'
                        ? 'Prerequisites must be completed first'
                        : stateName === 'current'
                          ? 'This task will advance the current operational phase'
                          : stateName === 'complete'
                            ? 'This task is already complete'
                            : '';
                      return `<button class="small-btn task-btn" title="${title}" data-fire="${f.id}" data-appliance="${a.applianceId}" data-task="${task}">${prefix}${task}</button>`;
                    }).join('')}
                  </div>` : ''}`
              : '';
          return `<div class="resource-row">
            <div>
              <b>${a.callsign}</b>
              <div class="resource-meta">
                ${appliance ? `${appliance.maxWater > 0 ? `${Math.round(appliance.currentWater)}/${appliance.maxWater} L • ` : ''}${appliance.task}` : ''}
              </div>
              ${taskControls}
            </div>
            <span class="badge ${a.status === 'En Route' ? 'status-enroute' : 'status-onscene'}">
              ${a.status}${a.status === 'En Route' ? ` ${Math.ceil(a.eta)}m` : ''}
            </span>
          </div>`;
        }).join('')
      : '<div class="mini">No resources dispatched.</div>';

    const dispatchOpen = !!state.incidentDispatchOpen[f.id];
    const dispatchSearch = String(state.incidentDispatchSearch[f.id] || '').trim().toLowerCase();

    const matchingAvailable = available.filter(x => {
      if (!dispatchSearch) return true;
      const haystack = [
        x.station.name,
        stationTypeLabel(x.station.type || 'BUSHFIRE'),
        x.appliance.callsign,
        x.appliance.code,
        x.appliance.role
      ].join(' ').toLowerCase();
      return haystack.includes(dispatchSearch);
    });

    const groupedAvailable = matchingAvailable.reduce((groups, x) => {
      const key = `${x.station.id}`;
      if (!groups[key]) groups[key] = {station:x.station, units:[]};
      groups[key].units.push(x);
      return groups;
    }, {});

    const dispatchButtons = selected
      ? `<div class="mutual-card">
          <div class="station-head">
            <strong>Available Resources</strong>
            <button class="small-btn dispatch-toggle-btn" data-fire="${f.id}" style="width:auto">
              ${dispatchOpen ? 'Hide' : `Show (${available.length})`}
            </button>
          </div>
          ${dispatchOpen ? `
            <input
              class="incident-resource-search"
              data-fire="${f.id}"
              type="search"
              placeholder="Search station, callsign or appliance…"
              value="${String(state.incidentDispatchSearch[f.id] || '').replace(/"/g,'&quot;')}"
              style="margin:6px 0"
            />
            ${matchingAvailable.length
              ? Object.values(groupedAvailable).map(group => `
                  <div class="card" style="margin:6px 0;padding:7px">
                    <div class="mini"><b>${group.station.name}</b> • ${stationTypeLabel(group.station.type || 'BUSHFIRE')}</div>
                    <div class="incident-actions" style="margin-top:5px">
                      ${group.units.map(x =>
                        `<button class="small-btn dispatch-btn" data-fire="${f.id}" data-appliance="${x.appliance.id}">
                          ${x.appliance.callsign}
                        </button>`
                      ).join('')}
                    </div>
                  </div>
                `).join('')
              : '<div class="mini">No available resources match this search.</div>'}
          ` : '<div class="mini">Expand to search and turn out resources.</div>'}
        </div>`
      : '';

    const specialists = state.specialResources.filter(r => r.fireId === f.id && r.status !== 'Released');
    const specialistHtml = specialists.length
      ? specialists.map(r => `<div class="resource-row">
          <span>${r.label}</span>
          <span>
            <span class="badge">${r.status}${r.status === 'Inbound' ? ` ${Math.ceil(r.eta)}m` : ''}</span>
            <button class="small-btn release-special" data-id="${r.id}">Release</button>
          </span>
        </div>`).join('')
      : '<div class="mini">No specialist resources assigned.</div>';

    const neededAgencies = incidentAgencyNeeds(f);
    const resolutionBar = isWildfireIncident(f)
      ? `<div class="progress"><div style="width:${f.containment}%"></div></div>
         <div class="mini">Containment ${f.containment.toFixed(1)}% • Control ${f.controlProgress.toFixed(1)}% • Mop-up ${f.mopUp.toFixed(1)}% • Mineral break ${Number(f.mineralBreakProgress || 0).toFixed(1)}%</div>
         <div class="mini">Control trend: ${
           f.containment >= 99.95 && f.controlProgress > 0
             ? 'containment locked — control is the current buffer'
             : (effectiveFireSuppression(f).wetAttack > 0 || effectiveFireSuppression(f).air > 0 || effectiveFireSuppression(f).plant > 0
                 ? 'suppression active'
                 : 'at risk of deterioration')
         }</div>`
      : `<div class="progress"><div style="width:${Number(f.resolution || 0)}%"></div></div>
         <div class="mini">Incident resolution ${Number(f.resolution || 0).toFixed(1)}%</div>`;

    const minimumReqs = incidentMinimumRequirements(f);
    const minimumReqHtml = minimumReqs.length
      ? `<div class="mutual-card">
          <strong>Minimum Response</strong>
          ${isWildfireIncident(f) ? `<div class="mini">Current level: ${wildfireAlarmLabel(f.alarmLevel || 0)}</div>` : ''}
          ${minimumReqs.map(r =>
            `<div class="mini">${r.met ? '✓' : '⚠'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}</div>`
          ).join('')}
          ${minimumReqs.every(r => r.met)
            ? '<div class="mini">Minimum attendance met.</div>'
            : '<div class="mini">Operational tasks will not advance until minimum attendance is met.</div>'}
        </div>`
      : '';

    const hints = workflowHints(f);
    const workflowHintHtml = hints.length
      ? `<div class="mutual-card">
          <strong>Operational Hints</strong>
          <div class="mini">${hints.map(h => `Next: ${h}`).join('<br>')}</div>
        </div>`
      : '';

    const alarmControls = isWildfireIncident(f)
      ? `<div class="incident-actions">
          ${[0,1,2,3].map(level =>
            `<button class="small-btn alarm-btn" data-fire="${f.id}" data-level="${level}" ${Number(f.alarmLevel || 0) === level ? 'disabled' : ''}>
              ${wildfireAlarmLabel(level)}
            </button>`
          ).join('')}
        </div>`
      : '';

    const agencyCommandsHtml = neededAgencies.map(agency => {
      const active = f.agencyCommands?.[agency] || 'None';
      const commands = agency === 'WAPOL'
        ? ['Establish Scene Command','Traffic Management','Investigation Lead','Search Coordination','Clear Police']
        : agency === 'SJA'
          ? ['Establish Medical Command','Triage Area','Treatment Area','Transport Coordinator','Standby Medical']
          : ['Establish Fire Command','Establish Sectors','Rescue Sector','Hazmat Sector','Safety Officer'];

      return `<div class="mutual-card">
        <strong>${agencyLabel(agency)} Command</strong>
        <div class="mini">Current: ${active}</div>
        <div class="incident-actions">
          ${commands.map(cmd => `<button class="small-btn agency-command-btn" data-fire="${f.id}" data-agency="${agency}" data-command="${cmd}">${cmd}</button>`).join('')}
        </div>
      </div>`;
    }).join('');

    const management = selected ? `
      <div class="mutual-card">
        <strong>Incident Management</strong>
        ${resolutionBar}
        <div class="incident-actions">
          ${isWildfireIncident(f) ? `<button class="small-btn sector-btn" data-fire="${f.id}">${f.sectorsEstablished ? 'Sectors Established' : 'Establish Sectors'}</button>` : ''}
          ${isWildfireIncident(f) ? `<button class="small-btn supervisor-btn" data-fire="${f.id}">${f.machineSupervisor ? 'Machine Supervisor ✓' : 'Assign Machine Supervisor'}</button>` : ''}
          ${f.assignments.length ? `<button class="small-btn release-all-btn" data-fire="${f.id}">Release All Appliances</button>` : ''}
        </div>
      </div>

      ${minimumReqHtml}
      ${workflowHintHtml}
      ${isWildfireIncident(f) ? `<div class="mutual-card"><strong>Alarm / Response Level</strong>${alarmControls}</div>` : ''}
      ${agencyCommandsHtml}

      <div class="mutual-card">
        <strong>Specialist / State Resources</strong>
        <div class="incident-actions">
          <button class="small-btn special-btn" data-fire="${f.id}" data-type="LAT">Request LAT</button>
          <button class="small-btn special-btn" data-fire="${f.id}" data-type="HELI">Request Helitac</button>
          <button class="small-btn special-btn" data-fire="${f.id}" data-type="SEAT">Request SEAT</button>
          <button class="small-btn special-btn" data-fire="${f.id}" data-type="LOADER">Request DBCA Loader</button>
          <button class="small-btn special-btn" data-fire="${f.id}" data-type="DOZER">Request DBCA Dozer</button>
        </div>
        ${specialistHtml}
      </div>
    ` : '';

    const collapsedSummary = isWildfireIncident(f)
      ? `${f.incidentType} • ${wildfireAlarmLabel(f.alarmLevel || 0)} • ${f.containment.toFixed(0)}% contained • ${f.assignments.length} unit${f.assignments.length === 1 ? '' : 's'}`
      : `${f.incidentType} • ${Number(f.resolution || 0).toFixed(0)}% resolved • ${f.assignments.length} unit${f.assignments.length === 1 ? '' : 's'}`;

    return `<div class="card" style="${selected ? 'outline:1px solid #777' : ''}" onclick="window.selectIncident(${f.id})">
      <div class="station-head">
        <div>
          <strong>${f.name}</strong>
          <span class="badge">${f.stage}</span>
          ${collapsed ? `<div class="mini">${collapsedSummary}</div>` : ''}
        </div>
        <button class="small-btn incident-collapse-btn" data-fire="${f.id}" style="width:auto">
          ${collapsed ? 'Expand' : 'Collapse'}
        </button>
      </div>

      ${collapsed ? '' : `
        <div class="mini">
          ${f.incidentType}<br>
          ${f.report}<br>
          ${f.classification}<br>
          Approx. ${f.areaHa.toFixed(1)} ha • Head ${Math.round(f.head || 0)} m<br>
          ${f.homeStation ? `Generated near ${f.homeStation} • ${f.distanceFromStation.toFixed(1)} km<br>` : ''}
          Age ${Math.floor(f.age)} min
        </div>
        ${isWildfireIncident(f)
          ? `<div class="progress"><div style="width:${f.containment}%"></div></div>
             <div class="mini">${f.containment.toFixed(1)}% contained</div>`
          : `<div class="progress"><div style="width:${Number(f.resolution || 0)}%"></div></div>
             <div class="mini">${Number(f.resolution || 0).toFixed(1)}% resolved</div>`}
        <div style="margin-top:6px">${assignments}</div>
        ${dispatchButtons}
        ${management}
      `}
    </div>`;
  }).join('');

  document.querySelectorAll('.incident-collapse-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      const fireId = Number(btn.dataset.fire);
      const current = state.incidentCollapsed[fireId] === undefined
        ? state.selectedIncidentId !== fireId
        : !!state.incidentCollapsed[fireId];
      state.incidentCollapsed[fireId] = !current;
      renderIncidents();
    };
  });

  document.querySelectorAll('.task-toggle-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      const key = btn.dataset.key;
      state.assignmentTaskOpen[key] = !state.assignmentTaskOpen[key];
      renderIncidents();
    };
  });

  document.querySelectorAll('.dispatch-toggle-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      const fireId = Number(btn.dataset.fire);
      state.incidentDispatchOpen[fireId] = !state.incidentDispatchOpen[fireId];
      renderIncidents();
    };
  });

  document.querySelectorAll('.incident-resource-search').forEach(input => {
    input.oninput = ev => {
      ev.stopPropagation();
      const fireId = Number(input.dataset.fire);
      state.incidentDispatchSearch[fireId] = input.value;
      renderIncidents();
    };
    input.onclick = ev => ev.stopPropagation();
  });

  document.querySelectorAll('.dispatch-btn').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      dispatchAppliance(Number(btn.dataset.fire), btn.dataset.appliance);
    };
  });

  document.querySelectorAll('.task-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      setTask(Number(btn.dataset.fire), btn.dataset.appliance, btn.dataset.task);
    };
  });

  document.querySelectorAll('.standdown-appliance-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      releaseApplianceFromIncident(
        Number(btn.dataset.fire),
        btn.dataset.appliance,
        'Stood down while en route'
      );
    };
  });

  document.querySelectorAll('.release-appliance-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      releaseApplianceFromIncident(
        Number(btn.dataset.fire),
        btn.dataset.appliance,
        'Released by Incident Controller'
      );
    };
  });

  document.querySelectorAll('.release-all-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      releaseAllIncidentAppliances(
        Number(btn.dataset.fire),
        'Released by Incident Controller'
      );
    };
  });

  document.querySelectorAll('.agency-command-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      agencyIncidentCommand(
        Number(btn.dataset.fire),
        btn.dataset.agency,
        btn.dataset.command
      );
    };
  });

  document.querySelectorAll('.special-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      requestSpecialResource(Number(btn.dataset.fire), btn.dataset.type);
    };
  });

  document.querySelectorAll('.release-special').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      releaseSpecial(Number(btn.dataset.id));
    };
  });

  document.querySelectorAll('.supervisor-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      setMachineSupervisor(Number(btn.dataset.fire));
    };
  });

  document.querySelectorAll('.alarm-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      setIncidentAlarm(Number(btn.dataset.fire), Number(btn.dataset.level));
    };
  });

  document.querySelectorAll('.sector-btn').forEach(btn => {
    btn.onclick = ev => {
      ev.stopPropagation();
      establishSectors(Number(btn.dataset.fire));
    };
  });

  if (focusedSearch) {
    const input = document.querySelector(`.incident-resource-search[data-fire="${focusedSearch.fireId}"]`);
    if (input) {
      input.focus();
      try {
        input.setSelectionRange(focusedSearch.start, focusedSearch.end);
      } catch (e) {}
    }
  }
}

window.selectIncident = function(id) {
  state.selectedIncidentId = id;
  state.incidentCollapsed[id] = false;
  const f = state.fires.find(x => x.id === id);
  if (f) map.panTo(f.center);
  renderIncidents();
};

function clearDraftPolygonMarkers() {
  state.draftMarkers.forEach(m => map.removeLayer(m));
  state.draftMarkers = [];
}

function warningLabel(level) {
  return level === 'watch' ? 'Watch and Act'
    : level === 'emergency' ? 'Emergency Warning'
    : level === 'evacuate' ? 'Evacuation Area'
    : 'Advice';
}

function renderWarnings() {
  const active = state.warnings.filter(w => w.active);
  if (!active.length) {
    els.warningsList.innerHTML = 'No active warnings.';
    return;
  }
  els.warningsList.innerHTML = active.map(w => `
    <div class="card">
      <strong>${warningLabel(w.level)}</strong>
      <div class="mini">${w.message}<br>Issued ${w.issuedAt}</div>
      <div class="incident-actions">
        ${w.level !== 'emergency' ? `<button class="small-btn warning-up" data-id="${w.id}">Upgrade</button>` : ''}
        ${w.level !== 'advice' ? `<button class="small-btn warning-down" data-id="${w.id}">Downgrade</button>` : ''}
        <button class="small-btn warning-cancel" data-id="${w.id}">Cancel</button>
      </div>
      <div class="mini warning-history">${w.history.slice(-3).join('<br>')}</div>
    </div>
  `).join('');

  document.querySelectorAll('.warning-up').forEach(b => b.onclick = () => changeWarning(Number(b.dataset.id), 1));
  document.querySelectorAll('.warning-down').forEach(b => b.onclick = () => changeWarning(Number(b.dataset.id), -1));
  document.querySelectorAll('.warning-cancel').forEach(b => b.onclick = () => cancelWarning(Number(b.dataset.id)));
}

function changeWarning(id, direction) {
  const w = state.warnings.find(x => x.id === id);
  if (!w || !w.active) return;
  const levels = ['advice','watch','emergency'];
  let i = levels.indexOf(w.level);
  if (i < 0) i = 0;
  i = Math.max(0, Math.min(levels.length - 1, i + direction));
  w.level = levels[i];
  w.poly.setStyle(warningStyle(w.level));
  w.history.push(`${simTime()} — Changed to ${warningLabel(w.level)}`);
  w.poly.setPopupContent(`<b>${warningLabel(w.level)}</b><br>${w.message}<br>Updated ${simTime()}`);
  log(`Warning ${id} changed to ${warningLabel(w.level)}.`);
  renderWarnings();
}

function cancelWarning(id) {
  const w = state.warnings.find(x => x.id === id);
  if (!w || !w.active) return;
  w.active = false;
  w.history.push(`${simTime()} — Cancelled`);
  map.removeLayer(w.poly);
  log(`Warning ${id} cancelled.`);
  renderWarnings();
}

function finishPolygon() {
  if (state.draftPolygon.length < 3) {
    log('Warning polygon needs at least 3 points.');
    return;
  }
  const level = els.warningLevel.value;
  const message = (els.warningMessage.value || '').trim() || 'Monitor conditions and follow emergency information.';
  const poly = L.polygon(state.draftPolygon, warningStyle(level)).addTo(map);
  const id = state.warnings.length + 1;
  const issuedAt = simTime();
  poly.bindPopup(`<b>${warningLabel(level)}</b><br>${message}<br>Issued ${issuedAt}`);
  const warning = {
    id, level, message, poly, active:true, issuedAt,
    history:[`${issuedAt} — Issued as ${warningLabel(level)}`]
  };
  state.warnings.push(warning);
  state.polygons.push({level, poly});
  log(`${warningLabel(level)} polygon issued.`);
  state.draftPolygon = [];
  clearDraftPolygonMarkers();
  setTool(null);
  renderWarnings();
}
