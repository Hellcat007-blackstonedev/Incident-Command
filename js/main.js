/* UI event bindings, simulation loop and application startup. */
map.on('click', (e) => {
  if (state.tool === 'station') {
    openStationModal(e.latlng);
    setTool(null);
  } else if (state.tool === 'fire') {
    addFire(e.latlng);
    setTool(null);
  } else if (state.tool === 'icp') {
    addICP(e.latlng);
    setTool(null);
  } else if (state.tool === 'polygon') {
    state.draftPolygon.push(e.latlng);
    const m = L.circleMarker(e.latlng, {radius:5, color:'#fff', fillColor:'#fff', fillOpacity:1}).addTo(map);
    state.draftMarkers.push(m);
  }
});


els.saveStationModal.onclick = () => {
  if (!state.pendingStationLocation) return;

  const name = els.modalStationName.value.trim();
  if (!name) {
    alert('Give the station/brigade a name first.');
    return;
  }

  const codes = [];
  document.querySelectorAll('.applianceChoice:checked').forEach(c => {
    const qtyEl = c.closest('.check-item')?.querySelector('.applianceQty');
    const qty = Math.max(1, Math.min(6, Number(qtyEl?.value) || 1));
    for (let i = 0; i < qty; i++) codes.push(c.value);
  });
  const stationType = els.modalStationType.value || 'BUSHFIRE';

  if (state.editingStationId !== null) {
    updateStation(state.editingStationId, name, codes, stationType);
  } else {
    addStation(state.pendingStationLocation, name, codes, stationType);
  }

  closeStationModal();
};

if (els.confirmDeleteStation) {
  els.confirmDeleteStation.onclick = confirmDeleteStation;
}

if (els.cancelDeleteStation) {
  els.cancelDeleteStation.onclick = closeDeleteStationModal;
}

if (els.deleteStationModal) {
  els.deleteStationModal.onclick = e => {
    if (e.target === els.deleteStationModal) {
      closeDeleteStationModal();
    }
  };
}

if (els.saveRenameAppliance) {
  els.saveRenameAppliance.onclick = saveRenamedAppliance;
}

if (els.cancelRenameAppliance) {
  els.cancelRenameAppliance.onclick = closeRenameApplianceModal;
}

if (els.renameApplianceModal) {
  els.renameApplianceModal.onclick = e => {
    if (e.target === els.renameApplianceModal) {
      closeRenameApplianceModal();
    }
  };
}

if (els.renameApplianceInput) {
  els.renameApplianceInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRenamedAppliance();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeRenameApplianceModal();
    }
  });
}

els.modalStationType.onchange = refreshApplianceChoicesForStationType;

if (els.stationSearch) {
  els.stationSearch.addEventListener('input', () => {
    state.stationSearch = els.stationSearch.value || '';
    renderStations();
  });
}

if (els.stationsToggleBtn) {
  els.stationsToggleBtn.addEventListener('click', () => {
    state.stationsCollapsed = !state.stationsCollapsed;
    renderStations();
  });
}

els.cancelStationModal.onclick = closeStationModal;
els.stationModal.onclick = (e) => {
  if (e.target === els.stationModal) closeStationModal();
};

els.saveBtn.onclick = saveGame;
els.loadBtn.onclick = loadGame;
if (els.exportSaveBtn) els.exportSaveBtn.onclick = exportSaveFile;
if (els.importSaveBtn) els.importSaveBtn.onclick = () => els.importSaveInput?.click();
if (els.importSaveInput) {
  els.importSaveInput.onchange = async () => {
    const file = els.importSaveInput.files?.[0];
    if (file) await importLegacySaveFile(file);
    els.importSaveInput.value = '';
  };
}
els.newGameBtn.onclick = () => {
  if (confirm('Clear the saved game and start fresh?')) newGame();
};

els.pauseBtn.onclick = () => {
  state.paused = !state.paused;
  els.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  if (els.completedJobsCount) els.completedJobsCount.textContent = (state.completedJobs || []).length;
  log(state.paused ? 'Simulation paused.' : 'Simulation resumed.');
};
els.speedSel.onchange = () => state.speed = Number(els.speedSel.value);
els.stationTool.onclick = () => setTool('station');
els.fireTool.onclick = () => setTool('fire');
els.icpTool.onclick = () => setTool('icp');
els.cancelTool.onclick = () => {
  setTool(null);
  state.draftPolygon = [];
  clearDraftPolygonMarkers();
};
els.polygonTool.onclick = () => setTool('polygon');
els.finishPolygon.onclick = finishPolygon;
els.clearLastPolygon.onclick = () => {
  const w = [...state.warnings].reverse().find(x => x.active);
  if (w) {
    cancelWarning(w.id);
  } else {
    log('No active warning polygon to delete.');
  }
};
els.autoCallsBtn.onclick = () => {
  state.autoCalls = !state.autoCalls;
  els.autoCallsBtn.textContent = `Auto Calls: ${state.autoCalls ? 'ON' : 'OFF'}`;
  updateWindUI();
  log(`Automatic incident generation ${state.autoCalls ? 'enabled' : 'disabled'}.`);
};

els.randomFireBtn.onclick = async () => {
  if (state.incidentGenerationPending) return;
  state.incidentGenerationPending = true;
  els.randomFireBtn.disabled = true;
  const generated = await randomIncidentNearStation();
  if (!generated) {
    log('Could not find a suitable land-based incident location. Try again or increase the radius.');
    state.incidentGenerationPending = false;
    els.randomFireBtn.disabled = false;
    return;
  }
  addFire(generated.latlng);
  const fire = state.fires[state.fires.length - 1];
  fire.homeStation = generated.station.name;
  fire.distanceFromStation = generated.distance;
  fire.marker.setPopupContent(
    `<b>${fire.name}</b><br>Initial report: smoke visible.<br>` +
    `Nearest generated station: ${generated.station.name}<br>` +
    `${generated.distance.toFixed(1)} km from station.<br>Status: Reported.`
  );
  log(`${fire.name} generated ${generated.distance.toFixed(1)} km from ${generated.station.name}.`);
  map.panTo(generated.latlng);
  state.incidentGenerationPending = false;
  els.randomFireBtn.disabled = false;
};

setInterval(() => {
  if (state.paused) return;
  // True simulation-time pacing:
  // Timer ticks every 250 ms.
  // 1x  = real time
  // 2x  = twice real time
  // 5x  = five-times real time
  // 10x = ten-times real time
  //
  // A 5-minute turnout at 1x therefore takes 5 real minutes.
  const dt = (0.25 / 60) * state.speed;
  state.minutes += dt;
  try {
    updateWindSimulation(dt);
  } catch (err) {
    console.error('Wind simulation error:', err);
  }

  try {
    updateFuelSimulation(dt);
  } catch (err) {
    console.error('Fuel simulation error:', err);
  }

  state.fires.filter(f => f.active).forEach(f => {
    try {
      spreadFire(f, dt);
    } catch (err) {
      console.error('Fire simulation error:', f.name, err);
    }
  });

  try {
    updateAssignments(dt);
    state.fires.slice().forEach(f => updateAgencyIncidentProgress(f, dt));
    updateReturningAppliances(dt);
  } catch (err) {
    console.error('Appliance movement simulation error:', err);
  }

  try {
    updateSpecialResources(dt);
  } catch (err) {
    console.error('Special resource simulation error:', err);
  }

  if (state.autoCalls && state.stations.length) {
    state.autoCallAccumulator += dt;
    // Approximately one call every 45–90 simulation minutes.
    if (state.autoCallAccumulator >= 45 + Math.random() * 45) {
      state.autoCallAccumulator = 0;
      if (!state.incidentGenerationPending) {
        state.incidentGenerationPending = true;
        randomIncidentNearStation().then(generated => {
          if (generated) {
            addFire(generated.latlng);
            const fire = state.fires[state.fires.length - 1];
            fire.homeStation = generated.station.name;
            fire.distanceFromStation = generated.distance;
            log(`Automatic call generated ${generated.distance.toFixed(1)} km from ${generated.station.name}.`);
          }
        }).finally(() => {
          state.incidentGenerationPending = false;
        });
      }
    }
  }

  updateClock();
  renderStations();
  renderIncidents();
}, 250);


// ---- Desktop auto-update UI -------------------------------------------------
(() => {
  const desktop = window.bushfireDesktop;
  if (!desktop?.isElectron || typeof desktop.onUpdateStatus !== 'function') return;

  const modal = document.getElementById('updateModal');
  const title = document.getElementById('updateModalTitle');
  const message = document.getElementById('updateModalMessage');
  const progressWrap = document.getElementById('updateProgressWrap');
  const progressBar = document.getElementById('updateProgressBar');
  const progressText = document.getElementById('updateProgressText');
  const installBtn = document.getElementById('updateInstallBtn');
  const laterBtn = document.getElementById('updateLaterBtn');
  const hint = document.getElementById('updateModalHint');

  if (!modal || !title || !message || !installBtn || !laterBtn) return;

  let hiddenDuringDownload = false;

  const showUpdateModal = () => {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  };

  const hideUpdateModal = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  };

  laterBtn.addEventListener('click', () => {
    hiddenDuringDownload = true;
    hideUpdateModal();
  });

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    installBtn.textContent = 'Restarting…';
    const result = await desktop.installUpdate();
    if (!result?.ok) {
      installBtn.disabled = false;
      installBtn.textContent = 'Restart & Install';
      message.textContent = 'The update could not be installed automatically. Please try again.';
    }
  });

  desktop.onUpdateStatus(status => {
    if (!status || typeof status !== 'object') return;

    if (status.state === 'available') {
      hiddenDuringDownload = false;
      title.textContent = 'New Update Available';
      message.textContent = status.version
        ? `Incident Command v${status.version} is available and will download in the background.`
        : 'A new version of Incident Command is available and will download in the background.';
      if (progressWrap) progressWrap.style.display = '';
      if (progressBar) progressBar.style.width = '0%';
      if (progressText) progressText.textContent = 'Starting download…';
      installBtn.style.display = 'none';
      laterBtn.textContent = 'Hide';
      if (hint) hint.textContent = 'You can keep playing while the update downloads.';
      showUpdateModal();
      return;
    }

    if (status.state === 'downloading') {
      const pct = Math.max(0, Math.min(100, Number(status.percent) || 0));
      if (progressWrap) progressWrap.style.display = '';
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressText) progressText.textContent = `Downloading… ${Math.round(pct)}%`;
      if (!hiddenDuringDownload && !modal.classList.contains('open')) showUpdateModal();
      return;
    }

    if (status.state === 'downloaded') {
      hiddenDuringDownload = false;
      title.textContent = 'Update Ready';
      message.textContent = status.version
        ? `Incident Command v${status.version} has been downloaded and is ready to install.`
        : 'The latest Incident Command update has been downloaded and is ready to install.';
      if (progressWrap) progressWrap.style.display = '';
      if (progressBar) progressBar.style.width = '100%';
      if (progressText) progressText.textContent = 'Download complete';
      installBtn.disabled = false;
      installBtn.textContent = 'Restart & Install';
      installBtn.style.display = '';
      laterBtn.textContent = 'Later';
      if (hint) hint.textContent = 'If you choose Later, the update will install automatically when Incident Command exits.';
      showUpdateModal();
      return;
    }

    if (status.state === 'error') {
      // Do not throw an intrusive popup for a transient GitHub/network error.
      // If the updater window is already visible, give the player useful feedback.
      if (modal.classList.contains('open')) {
        title.textContent = 'Update Check Failed';
        message.textContent = 'Incident Command could not contact the update service. You can keep playing and it will try again later.';
        if (progressWrap) progressWrap.style.display = 'none';
        installBtn.style.display = 'none';
        laterBtn.textContent = 'Close';
        if (hint) hint.textContent = '';
      }
      console.warn('Incident Command updater:', status.message || 'Unknown updater error');
    }
  });
})();

log('Incident Command v0.16.4 initialized.');
randomizeWind();
randomizeFuelLoad();
ensureRescueHelicopterBases();
renderStations();
log('v0.16.4 loaded: desktop shutdown reliability and in-game updater UI enabled.');
