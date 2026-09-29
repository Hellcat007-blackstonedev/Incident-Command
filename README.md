# Incident Command

**Incident Command** is a Western Australian emergency services management simulation focused on incident response, resource coordination, and operational decision-making.

Built as a standalone Electron application, the game puts you in charge of emergency resources across Western Australia. Dispatch appliances, manage developing incidents, coordinate multiple agencies, establish incident control, and keep crews and aircraft working as conditions change.

> Incident Command is an independent simulation project and is not affiliated with DFES, WA Police, St John WA, DBCA, SES, or any other government or emergency service organisation.

---

## Features

### Emergency Incident Management
- Dynamic incident generation
- Bushfires, structural fires, vehicle fires, road crashes, disturbances, and other emergency calls
- Incident classifications and live status updates
- Collapsible active incident cards
- Completed job tracking

### Bushfire Simulation
- Fires spread and develop over time
- Dynamic wind direction and wind speed
- Dynamic fuel load simulation
- Containment, control, blackout, mop-up, and safe stages
- Fire growth can change as weather and fuel conditions change
- Automatic escalation and alarm behaviour

### Multi-Agency Response
Manage resources from multiple services, including:

- Bush Fire Brigades / Volunteer Bush Fire Brigades
- Volunteer Fire & Rescue Service
- Volunteer Fire & Emergency Services
- Career Fire & Rescue Service
- WA Police
- St John Ambulance
- State Emergency Service
- DBCA
- Aviation resources

### Appliance & Resource Management
A growing fleet of emergency resources including:

- Light Tankers
- 1.4R, 2.4R, 3.4U, 4.4B and 12.2 appliances
- Urban Pumps and rescue appliances
- Ambulances and paramedic units
- Police patrol and traffic units
- SES Rescue
- DBCA loaders and dozers
- Helitacs
- LATs
- SEATs
- Rescue helicopters

Resources have different capabilities, water capacities, speeds, and operational roles.

### Aviation
- Helitac and fixed-wing firefighting aircraft
- Large Air Tanker support
- Rescue helicopters based from Jandakot and Bunbury
- Aircraft can be dispatched, released, returned, and re-tasked
- Additional LAT support can be brought in when the WA-based aircraft is already committed

### Incident Control
- Establish Incident Control Points
- Resources can stage through an ICP
- Coordinate larger incidents with expanding resource requirements
- Fireground progress is affected by the type and number of resources assigned

### Map & Routing
- Interactive map
- Search and location tools
- Road routing for ground resources
- Direct flight routing for aircraft
- Station markers and live resource movement

### Stations
- Create and edit emergency service stations
- Allocate appliances to stations
- Rename appliances and callsigns
- Delete player-created stations
- Different station types provide different fleets and capabilities

### Save System
- Native Electron save file
- Export and import save files
- Legacy browser-save migration support
- Automatic save storage inside the application's user-data folder

---

## Installation

1. Open the latest **GitHub Release**.
2. Download:

   `Incident Command Setup <version>.exe`

3. Run the installer.
4. Launch **Incident Command** from the Start Menu or desktop shortcut.

You do **not** need Node.js, npm, or the source code to play the installed version.

Windows may display a SmartScreen warning on unsigned builds.

---

## Updates

Incident Command supports automatic updates through GitHub Releases.

When a newer version is published, installed copies can check for the latest release and download the update. Updates are installed when the application is restarted or closed, depending on the update state.

---

## Development

Incident Command is currently under active development.

The project is built with:

- Electron
- HTML
- CSS
- JavaScript
- Leaflet
- OpenStreetMap / Esri map services
- OSRM routing

The current version is an early development build, so systems, balance, UI, incident behaviour, and resource availability may change significantly between versions.

---

## Internet Connection

Incident Command currently requires an internet connection for some map-related functionality, including:

- Map imagery
- Routing
- Location search
- Reverse geocoding

The core game runs locally, but the map is not currently fully offline.

---

## Feedback & Bugs

If you find a bug or have a suggestion, open an Issue on the GitHub repository.

When reporting a bug, include:

- Game version
- What you were doing when it happened
- What you expected to happen
- What actually happened
- Screenshots if relevant

---

## Project

Developed by **Hellcat007**.

Incident Command is a fictional emergency-services management simulation inspired by Western Australian emergency response operations. It is intended for entertainment and simulation purposes and should not be treated as operational emergency-services training or guidance.
