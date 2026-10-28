![TUMuch Coffee Logo](assets/pitch/logo-tumuch-coffee.jpg)

# TUMuch Coffee: 3D Climate Map of Heilbronn

**TUMuch Coffee: 3D Climate Map of Heilbronn** is an interactive browser-based 3D urban climate simulator that lets citizens, students, and city planners explore Heilbronn today, project its climate through 2050, and test greener street designs in real time. By combining 43,031 city trees from the municipal Baumkataster with 3D buildings, Open-Meteo climate projections, and a live microclimate layer, users can place trees or modify buildings and immediately see the local impact on temperature, air pollution, and humidity.

## Features

All features below are implemented in this repository (`index.html`, `cadastre.js`, `metrics-card.js`, `time-slider.js`, `climate-layer.js`, `legend.js`, `about-card.js`, and `intro.js`):

- **Interactive 3D Map of Heilbronn (`index.html`, `legend.js`, `about-card.js`, `intro.js`)**:
  - Built with **MapLibre GL JS** (`positron` vector tiles via OpenFreeMap) and a custom **Three.js** 3D WebGL layer, draped over 3D elevation from **AWS Terrain Tiles** (`terrarium` DEM).
  - Custom cartographic styling for parks, grass/meadows, forests, water bodies, roads, and 3D extruded buildings, accompanied by a collapsible map legend, an `"About this map"` data-sources card (`i` button), and a welcome screen overlay (skippable via `?nointro`).
- **43k City Trees from the Baumkataster (`cadastre.js`, `trees.json`, `first_time_setup/trees.py`)**:
  - Renders **43,031** real trees from the Stadt Heilbronn Baumkataster using Three.js `InstancedMesh` (broadleaf icosahedron crowns, conifer cone crowns, and trunks), colour-coded by tree type (`Laubbaum`, `Nadelbaum`, `Obstbaum`, `Baumgruppe`, `Unbekannt`) with camera frustum and distance culling (`900 m`) plus automatic terrain elevation clamping.
  - **Inspect Tree mode (`ℹ Inspect tree`)**: Click any cadastre tree to open a popup with its German and scientific species name, tree type, street, trunk circumference (`Stammumfang`), crown diameter (`Krone`), and tree number (`BAUM_NR`).
  - **Live OSM Trees (`Load real trees`)**: Fetch additional mapped trees around the current view via the OpenStreetMap Overpass API.
- **Live & Monthly Metrics Card (`metrics-card.js`, `metrics-card.css`)**:
  - Floating expandable card in the top-right corner showing live Heilbronn weather and air quality from Open-Meteo: temperature, feels-like temperature, European AQI with EEA colour bands, relative humidity, PM2.5, PM10, NO₂, ozone, wind speed, and precipitation.
- **Time Slider 2020–2050: Measured vs. Projected Data (`time-slider.js`, `data/climate-months.json`, `scripts/fetch_climate.py`)**:
  - Scrub month by month from **Jan 2020 to Dec 2050** (or jump back to **Now**), all precomputed in `data/climate-months.json` for instant offline scrubbing:
    - **Measured history (2020–present)**: Monthly averages from Open-Meteo ERA5 reanalysis and CAMS air quality archive.
    - **Climate projections (present–2050)**: Ensemble mean of **7 CMIP6 HighResMIP climate models** averaged over a ±5-year window and bias-corrected per calendar month against measured 2021–2025 ERA5 data. Displays average/max temperature, hot days (≥ 30 °C), tropical nights (≥ 20 °C), monthly rainfall, heavy-rain days (≥ 20 mm), wind speed, humidity, and SSP2-4.5 PM2.5/PM10 estimates (Clayton et al. 2024).
- **Interactive Street Editing: Place Trees, Place Buildings, Select & Delete Buildings (`index.html`)**:
  - **Place trees & buildings (`🌳 Place tree`, `🏢 Place building`, `↩ Undo`)**: Click anywhere on the map to add 3D trees or 5-storey procedural-window buildings clamped to the terrain.
  - **Select, delete & restore map buildings (`🏠 Select building`, `🗑 Delete building`, `♻ Restore building`)**: Extracts individual building footprints from vector tiles, raycasts 3D clicks using the shared camera projection matrix, highlights the selected building in orange, and lets you remove (`Delete`/`Backspace` or button) or restore existing buildings to test unsealing and redevelopment.
  - **Session persistence**: All placed trees, placed buildings, and deleted buildings are saved in `sessionStorage` across reloads.
- **Climate Layers & Scenario Comparison (`climate-layer.js`)**:
  - Computes a 2 km × 2 km (100 × 100 grid, 20 m cells) microclimate heuristic model from building density, Baumkataster + user tree canopy, parks/green cover, water bodies, road traffic weights, and terrain altitude.
  - Switch between **🌡 Temp**, **🏭 Pollution (PM2.5)**, and **💧 Humidity** overlays across four weather scenarios (**Live now**, **Heatwave 34 °C**, **Winter storm −2 °C**, **Heavy rain 11 °C**) with an animated canvas **rain / snow particle effect** that transitions between rain and snow based on local cell temperature (`≤ 0.5 °C`).
  - **Before/After Scenario Comparison**: Compares baseline vs. your scene edits (`+trees`, `+buildings`, `−deleted buildings`), with a **"Show only the change from my edits"** delta heatmap toggle, a live hover tooltip showing local values and `Δ°C`, and a **"Your edits"** summary quantifying affected area (`m²`) plus average and peak changes in temperature (`°C`), PM2.5 (`%`), and humidity.

## How to run

No API keys or build step are required—`trees.json` and `data/climate-months.json` are already precomputed in the repository.

```bash
# 1. Clone the repository and enter the folder
git clone https://github.com/BG240807/TUMuch_coffee.git
cd TUMuch_coffee

# 2. Start any local static HTTP server
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser (append `?nointro` to skip the welcome screen).

### Optional: Rebuilding Precomputed Data

```bash
# Install Python dependencies for shapefile conversion
pip install -r requirements.txt

# Convert the Stadt Heilbronn Baumkataster shapefile into trees.json
python3 first_time_setup/trees.py data/trees/SHN_Baumkataster_open_UTM32N_EPSG25832.shp trees.json

# Re-fetch and bias-correct 2020–2050 monthly climate data from Open-Meteo into data/climate-months.json
python3 scripts/fetch_climate.py
```

## Data sources

- **Stadt Heilbronn Baumkataster (dl-de/by-2-0)**: Datenquelle: Stadt Heilbronn, [www.heilbronn.de](https://www.heilbronn.de), licensed under [Data licence Germany – attribution – Version 2.0 (dl-de/by-2-0)](https://www.govdata.de/dl-de/by-2-0) (`data/trees/SHN_Baumkataster_open_UTM32N_EPSG25832.*` → 43,031 trees in `trees.json`).
- **OpenStreetMap / OpenFreeMap**: `© OpenStreetMap contributors` (ODbL), vector tiles served via [OpenFreeMap](https://openfreemap.org/) (`positron` style) for 3D building footprints, parks, land cover, water bodies, and road networks, plus the Overpass API for on-demand OSM tree loading.
- **Open-Meteo**: [Open-Meteo.com](https://open-meteo.com/) for live weather (`/v1/forecast`) and air quality (`/v1/air-quality`), historical ERA5 reanalysis (`/v1/archive`), and 7-model CMIP6 HighResMIP climate projections through 2050 (`/v1/climate`), supplemented by Europe-wide SSP2-4.5 PM trend estimates (Clayton et al. 2024, *ACP* 24:10717).
- **AWS Terrain Tiles**: [AWS Open Data Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) for 3D terrain elevation in MapLibre and local altitude cooling in the climate layer.

## Team

Built by **Team TUMuch Coffee** for the **Green City Hackathon Heilbronn 2026**:

- **Taha Anjum (`Tahaa00`)** — Live & monthly metrics card, 2020–2050 time slider & CMIP6 climate projection pipeline (`scripts/fetch_climate.py`), terrain height alignment, base map styling, legend, about card, and welcome screen.
- **Bodhideepto Gupta (`BodhideeptoGupta` / `BG240807`)** — Baumkataster shapefile pipeline (`first_time_setup/trees.py`), instanced 3D tree cadastre rendering & frustum culling (`cadastre.js`), and 3D building selection, deletion & restoration.
- **Youssef Day (`youssef day`)** — 3D MapLibre + Three.js scene foundation and interactive local climate layers, weather scenarios, rain/snow particle system, and edit-delta simulation (`climate-layer.js`).
