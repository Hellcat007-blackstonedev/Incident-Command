/* Incident Command v0.11.0
 * Core bootstrap: Leaflet map, controls, game state, shared constants/helpers.
 */
const map = L.map('map', { zoomControl: true }).setView([-31.95, 115.86], 8);

// Esri public raster basemaps - no API key required for this HTML prototype.
const baseLayers = {
  "Street": L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom:19,
      attribution:'Tiles &copy; Esri'
    }
  ),
  "Satellite": L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom:19,
      attribution:'Tiles &copy; Esri'
    }
  ),
  "Topo": L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom:19,
      attribution:'Tiles &copy; Esri'
    }
  )
};

baseLayers["Street"].addTo(map);
L.control.layers(baseLayers, null, {
  position:'topright',
  collapsed:false
}).addTo(map);


// Place search (OpenStreetMap/Nominatim). Manual searches only.
const PlaceSearchControl = L.Control.extend({
  options:{position:'topleft'},
  onAdd:function() {
    const box = L.DomUtil.create('div','map-search-control');
    const row = L.DomUtil.create('div','search-row',box);
    const input = L.DomUtil.create('input','',row);
    input.type = 'search';
    input.placeholder = 'Search town / place…';
    input.setAttribute('aria-label','Search map place');
    const button = L.DomUtil.create('button','',row);
    button.type = 'button';
    button.textContent = 'Search';
    const results = L.DomUtil.create('div','map-search-results',box);

    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);

    async function runSearch() {
      const q = input.value.trim();
      if (!q) return;
      button.disabled = true;
      button.textContent = '…';
      results.textContent = 'Searching…';

      try {
        const url =
          `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=au&limit=6&addressdetails=1&q=${encodeURIComponent(q)}`;
        const res = await fetchWithTimeout(url, 4500);
        if (!res.ok) throw new Error('search failed');
        const items = await res.json();
        results.innerHTML = '';

        if (!items.length) {
          results.textContent = 'No places found.';
        } else {
          items.forEach(item => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'map-search-result';
            b.textContent = item.display_name;
            b.onclick = () => {
              const lat = Number(item.lat);
              const lng = Number(item.lon);
              if (Number.isFinite(lat) && Number.isFinite(lng)) {
                map.setView([lat,lng], 14);
                results.innerHTML = '';
              }
            };
            results.appendChild(b);
          });
        }
      } catch (err) {
        results.textContent = 'Search unavailable.';
      } finally {
        button.disabled = false;
        button.textContent = 'Search';
      }
    }

    button.addEventListener('click', runSearch);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runSearch();
      }
    });

    return box;
  }
});
map.addControl(new PlaceSearchControl());


const state = {
  paused: false,
  speed: 1,
  minutes: 12 * 60,
  tool: null,
  stations: [],
  fires: [],
  icps: [],
  polygons: [],
  draftPolygon: [],
  draftMarkers: [],
  nextStation: 1,
  nextFire: 1,
  pendingStationLocation: null,
  selectedIncidentId: null,
  editingStationId: null,
  renamingApplianceId: null,
  deletingStationId: null,
  autoCalls: false,
  windSimulation: true,
  simulatedWindBearing: 112.5,
  simulatedWindSpeed: 18,
  simulatedGust: 22,
  windTrend:'steady',
  windTargetBearing:112.5,
  windTargetSpeed:18,
  windChangeTimer:0,
  windGustTimer:0,
  fuelLoad:1,
  fuelTarget:1,
  fuelChangeTimer:0,
  autoCallAccumulator: 0,
  nextSpecialId: 1,
  specialResources: [],
  returningAppliances: [],
  completedJobs: [],
  incidentGenerationPending:false,
  warnings: [],
  stationsCollapsed:false,
  stationSearch:'',
  incidentDispatchOpen:{},
  incidentDispatchSearch:{},
  assignmentTaskOpen:{},
  incidentCollapsed:{}
};

const els = {
  clock: document.getElementById('clock'),
  weatherStatus: document.getElementById('weatherStatus'),
  completedJobsCount: document.getElementById('completedJobsCount'),
  pauseBtn: document.getElementById('pauseBtn'),
  speedSel: document.getElementById('speedSel'),
  stationTool: document.getElementById('stationTool'),
  fireTool: document.getElementById('fireTool'),
  icpTool: document.getElementById('icpTool'),
  cancelTool: document.getElementById('cancelTool'),
  polygonTool: document.getElementById('polygonTool'),
  finishPolygon: document.getElementById('finishPolygon'),
  clearLastPolygon: document.getElementById('clearLastPolygon'),
  warningLevel: document.getElementById('warningLevel'),
  stationsList: document.getElementById('stationsList'),
  stationSearch: document.getElementById('stationSearch'),
  stationsToggleBtn: document.getElementById('stationsToggleBtn'),
  incidentsList: document.getElementById('incidentsList'),
  log: document.getElementById('log'),
  randomFireBtn: document.getElementById('randomFireBtn'),
  incidentRadius: document.getElementById('incidentRadius'),
  deleteStationModal: document.getElementById('deleteStationModal'),
  deleteStationMessage: document.getElementById('deleteStationMessage'),
  confirmDeleteStation: document.getElementById('confirmDeleteStation'),
  cancelDeleteStation: document.getElementById('cancelDeleteStation'),
  renameApplianceModal: document.getElementById('renameApplianceModal'),
  renameApplianceCurrent: document.getElementById('renameApplianceCurrent'),
  renameApplianceInput: document.getElementById('renameApplianceInput'),
  saveRenameAppliance: document.getElementById('saveRenameAppliance'),
  cancelRenameAppliance: document.getElementById('cancelRenameAppliance'),
  stationModal: document.getElementById('stationModal'),
  modalStationName: document.getElementById('modalStationName'),
  modalStationType: document.getElementById('modalStationType'),
  stationModalTitle: document.getElementById('stationModalTitle'),
  saveStationModal: document.getElementById('saveStationModal'),
  cancelStationModal: document.getElementById('cancelStationModal'),
  autoCallsBtn: document.getElementById('autoCallsBtn'),
  warningMessage: document.getElementById('warningMessage'),
  warningsList: document.getElementById('warningsList'),
  specialResources: document.getElementById('specialResources'),
  saveBtn: document.getElementById('saveBtn'),
  loadBtn: document.getElementById('loadBtn'),
  exportSaveBtn: document.getElementById('exportSaveBtn'),
  importSaveBtn: document.getElementById('importSaveBtn'),
  importSaveInput: document.getElementById('importSaveInput'),
  newGameBtn: document.getElementById('newGameBtn')
};

function log(msg) {
  const t = simTime();
  const line = document.createElement('div');
  line.textContent = `[${t}] ${msg}`;
  els.log.prepend(line);
}

function simTime() {
  const totalSeconds = Math.floor(state.minutes * 60) % (24 * 60 * 60);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2,'0');
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2,'0');
  const ss = String(totalSeconds % 60).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

function updateClock() {
  els.clock.textContent = simTime();
}

function setTool(tool) {
  state.tool = tool;
  [els.stationTool, els.fireTool, els.icpTool, els.polygonTool].forEach(b => b.classList.remove('active'));
  if (tool === 'station') els.stationTool.classList.add('active');
  if (tool === 'fire') els.fireTool.classList.add('active');
  if (tool === 'icp') els.icpTool.classList.add('active');
  if (tool === 'polygon') els.polygonTool.classList.add('active');
}

function fireColor() { return '#d94b3d'; }

function warningStyle(level) {
  const styles = {
    advice: { color:'#4d9de0', fillColor:'#4d9de0' },
    watch: { color:'#e6a23c', fillColor:'#e6a23c' },
    emergency: { color:'#d94b3d', fillColor:'#d94b3d' },
    evacuate: { color:'#a64dff', fillColor:'#a64dff' }
  };
  return {...styles[level], weight:2, fillOpacity:.18};
}

function makeIcon(label, bg) {
  const safeLabel = String(label ?? '');
  return L.divIcon({
    className: '',
    html: `<div style="
      transform:translate(-50%,-50%);
      display:inline-block;
    "><div style="
      display:inline-block;
      background:${bg};
      color:white;
      border:2px solid rgba(255,255,255,.92);
      border-radius:999px;
      box-shadow:0 1px 6px #0008;
      padding:4px 10px;
      font:700 12px/1.15 system-ui,sans-serif;
      text-align:center;
      white-space:nowrap;
      box-sizing:border-box;
    ">${safeLabel}</div></div>`,
    iconSize:null,
    iconAnchor:[0,0],
    popupAnchor:[0,-12]
  });
}

const APPLIANCE_CATALOGUE = {
  "1.4R": { water:1000, drive:"4x4", role:"Rural fire appliance", attack:1.00, services:["BUSHFIRE","VFES"] },
  "2.4R": { water:2000, drive:"4x4", role:"Rural fire appliance", attack:1.20, services:["BUSHFIRE","VFES"] },
  "3.4U": { water:3000, drive:"4x4", role:"Urban fire appliance", attack:1.05, services:["BUSHFIRE","VFRS","VFES","CFRS"] },
  "4.4B": { water:4000, drive:"4x4", role:"Broadacre appliance", attack:1.45, services:["BUSHFIRE","VFES"] },
  "12.2": { water:12000, drive:"2WD", role:"Bulk water tanker / water source", attack:0.00, services:["BUSHFIRE","VFES"] },

  "Country Pump": { water:2000, drive:"4x2", role:"Country Pump", attack:1.15, services:["VFRS","CFRS"] },
  "HSR": { water:500, drive:"4x2", role:"Heavy Rescue", attack:0.30, services:["VFRS","CFRS"] },
  "MP": { water:2000, drive:"4x2", role:"Medium Pump", attack:1.30, services:["VFRS","CFRS"] },
  "UPHR": { water:1800, drive:"4x2", role:"Urban Pump Heavy Rescue", attack:1.25, services:["VFRS","CFRS"] },
  "UP": { water:1800, drive:"4x2", role:"Urban Pump", attack:1.20, services:["VFRS","CFRS"] },
  "Light Tanker": { water:1000, drive:"4x4", role:"Light Tanker", attack:0.85, services:["BUSHFIRE","VFRS","VFES","CFRS"] },
  "CLP": { water:0, drive:"4x2", role:"Combined Ladder Platform", attack:0.45, services:["CFRS"] },
  "Rehab": { water:0, drive:"4x2", role:"Rehab Truck", attack:0.05, services:["VFRS","CFRS"] },
  "VRV": { water:0, drive:"4x2", role:"VRV Truck", attack:0.10, services:["VFRS","CFRS"] },
  "RCR Tender": { water:0, drive:"4x4", role:"RCR Tender", attack:0.20, services:["VFRS","CFRS"] },

  "GD Patrol": { water:0, drive:"Road", role:"General Duties Patrol", attack:0, services:["WAPOL"] },
  "Traffic": { water:0, drive:"Road", role:"Traffic Unit", attack:0, services:["WAPOL"] },
  "Police Van": { water:0, drive:"Road", role:"Police Van", attack:0, services:["WAPOL"] },

  "Ambulance": { water:0, drive:"Road", role:"Emergency Ambulance", attack:0, services:["SJA"] },
  "Paramedic": { water:0, drive:"Road", role:"Paramedic Response Unit", attack:0, services:["SJA"] },
  "Patient Transport": { water:0, drive:"Road", role:"Patient Transport Vehicle", attack:0, services:["SJA"] },

  "SES Rescue": { water:0, drive:"4x4", role:"SES Rescue Unit", attack:0.20, services:["SES"] },

  "DBCA Loader": { water:0, drive:"Road", role:"DBCA Loader", attack:0, services:["DBCA"] },
  "DBCA Dozer": { water:0, drive:"Road", role:"DBCA Dozer", attack:0, services:["DBCA"] },

  "Helitac": { water:0, drive:"Air", role:"Helitac", attack:0, services:["AIRBASE"], airSpeed:220 },
  "Rescue Helicopter": { water:0, drive:"Air", role:"State Rescue Helicopter", attack:0, services:["AIRBASE"], airSpeed:250 },
  "LAT": { water:0, drive:"Air", role:"Large Air Tanker", attack:0, services:["AIRBASE"], airSpeed:430 },
  "SEAT": { water:0, drive:"Air", role:"Single Engine Air Tanker", attack:0, services:["AIRBASE"], airSpeed:300 }
};


function stationColor(type) {
  if (type === 'VFRS') return '#c0392b';
  if (type === 'VFES') return '#d35400';
  if (type === 'CFRS') return '#a93226';
  if (type === 'WAPOL') return '#2c3e50';
  if (type === 'SJA') return '#16a085';
  if (type === 'SES') return '#e67e22';
  if (type === 'DBCA') return '#6b7d3a';
  if (type === 'AIRBASE') return '#3b6ea8';
  return '#2e7d32';
}

function stationTypeLabel(type) {
  if (type === 'VFRS') return 'Volunteer Fire & Rescue Service';
  if (type === 'VFES') return 'Volunteer Fire & Emergency Services';
  if (type === 'CFRS') return 'Career Fire & Rescue Service';
  if (type === 'WAPOL') return 'WA Police';
  if (type === 'SJA') return 'St John WA';
  if (type === 'SES') return 'State Emergency Service';
  if (type === 'DBCA') return 'DBCA Depot / Work Centre';
  if (type === 'AIRBASE') return 'Aircraft Base / Airfield';
  return 'Bush Fire Brigade';
}
