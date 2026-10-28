![TUMuch Coffee Logo](assets/pitch/logo-tumuch-coffee.jpg)

# TUMuch Coffee: 3D Climate Map of Heilbronn

**TUMuch Coffee: 3D Climate Map of Heilbronn** is an interactive browser-based 3D urban climate simulator that lets citizens, students, and city planners explore Heilbronn today, project its climate through 2050, and test greener street designs in real time. By combining 43,031 city trees from the municipal Baumkataster with 3D buildings, Open-Meteo climate projections, and a live microclimate layer, users can place trees or modify buildings and immediately see the local impact on temperature, air pollution, and humidity.

## Features

All features below are implemented in this repository (`index.html`, `cadastre.js`, `placement.js`, `comparison-card.js`, `metrics-card.js`, `time-slider.js`, `climate-layer.js`, `legend.js`, `about-card.js`, and `intro.js`):

- **Interactive 3D Map of Heilbronn (`index.html`, `legend.js`, `about-card.js`, `intro.js`)**:
  - Built with **MapLibre GL JS** (`positron` vector tiles via OpenFreeMap) and a custom **Three.js** 3D WebGL layer, draped over 3D elevation from **AWS Terrain Tiles** (`terrarium` DEM).
  - Custom cartographic styling for parks, grass/meadows, forests, water bodies, roads, and 3D extruded buildings, accompanied by a collapsible map legend, an `"About this map"` data- & scientific-sources card (`i` button), and a welcome screen overlay (skippable via `?nointro`).
- **43k City Trees from the Baumkataster (`cadastre.js`, `trees.json`, `first_time_setup/trees.py`)**:
  - Renders **43,031** real trees from the Stadt Heilbronn Baumkataster using Three.js `InstancedMesh` (broadleaf icosahedron crowns, conifer cone crowns, and trunks), colour-coded by tree type (`Laubbaum`, `Nadelbaum`, `Obstbaum`, `Baumgruppe`, `Unbekannt`) with camera frustum and distance culling (`900 m`) plus automatic terrain elevation clamping.
  - **Inspect Tree mode (`ℹ Inspect tree`)**: Click any cadastre tree to open a popup with its German and scientific species name, tree type, street, trunk circumference (`Stammumfang`), crown diameter (`Krone`), and tree number (`BAUM_NR`).
- **Live & Monthly Metrics Card with Design Impact (`metrics-card.js`, `metrics-card.css`)**:
  - Floating expandable card in the top-right corner showing live Heilbronn weather and air quality from Open-Meteo: temperature, feels-like temperature, European AQI with EEA colour bands, relative humidity, PM2.5, PM10, NO₂, ozone, wind speed, and precipitation.
  - **Live Design Impact Banner**: Displays real-time local changes from your urban interventions: ambient air cooling (`Δ°C air` & peak), human thermal comfort (`Δ°C shade feel` / PET), PM2.5 change (`%`), stormwater runoff reduction (`%`), rooftop solar yield (`kWh/yr`), and avoided CO₂ (`t/yr`).
  - **Regulatory & Local Benchmarks**: Compares current and projected pollution against **EU 2030 binding limits (Directive 2024/2881)**, **WHO 2021 guidelines**, and the **LUBW Heilbronn Weinsberger Straße baseline**.
- **Time Slider 2020–2050: Measured vs. Projected Data (`time-slider.js`, `data/climate-months.json`, `scripts/fetch_climate.py`)**:
  - Scrub month by month from **Jan 2020 to Dec 2050** (or jump back to **Now**), all precomputed in `data/climate-months.json` for instant offline scrubbing and linked live to the ground climate heatmap:
    - **Measured history (2020–present)**: Monthly averages from Open-Meteo ERA5 reanalysis and CAMS air quality archive.
    - **Climate projections (present–2050)**: Ensemble mean of **7 CMIP6 HighResMIP climate models** averaged over a ±5-year window and bias-corrected per calendar month against measured 2021–2025 ERA5 data. Displays average/max temperature, hot days (≥ 30 °C), tropical nights (≥ 20 °C), monthly rainfall, heavy-rain days (≥ 20 mm), wind speed, humidity, and SSP2-4.5 PM2.5/PM10 estimates (Clayton et al. 2024).
- **Urban Planner Tools: Smart Placement, Green Areas, Tree Brush, Rotatable Buildings & Multi-Select (`index.html`, `placement.js`, `comparison-card.js`)**:
  - **Placement Rules & 3D Ghost Previews (`placement.js`)**: Checks real vector-tile geometry (roads, railways, water, existing buildings, and trees) in metres and shows a see-through green (`✓`) or red (`✗`) 3D preview before placing.
  - **One-Click Green Area (`🌳 Green area`)**: Hover any city block, square, or lawn to preview new trees and highlight buildings inside in red; choose **Demolish & plant** or **Keep buildings** (or hold `Shift` to draw custom polygon corners) with animated tree growth and floating cooling callouts.
  - **Tree Brush (`🖌️ Tree brush`)**: Hold and drag to paint trees along streets and parks with adjustable brush radius (`[` / `]` or `−` / `+`) and per-stroke undo.
  - **Customizable Map-Matched 3D Buildings (`🏢 Place building`)**: Place sandstone 3D buildings matching the MapLibre style with live controls for **rotation (`R` or `[` `]`, 15° steps)**, **width (`W`)**, **depth (`D`)**, and **storeys (`1–15` floors)**.
  - **Multi-Select, Box-Select, Delete & Restore (`👆 Select`, `🗑 Delete`, `♻ Restore`)**: Click, `Shift`-click, or drag a selection box to select multiple buildings, cadastre trees, or placed items at once; delete or batch-restore them, and toggle **Original vs. Proposal** in the **Scenario comparison** card (`comparison-card.js`).
- **Scientifically Grounded Climate Layers (`climate-layer.js`)**:
  - Computes a 3.2 km × 3.2 km microclimate grid with smooth radial edge blending from building sealing, Baumkataster + user tree canopy, parks, water bodies, road traffic weights, and terrain altitude, calibrated to empirical German/European urban climate literature:
    - **🌡 Air Temp ($T_a$)**: Logarithmic single-tree cooling (`−0.2 to −0.6 °C`) and neighborhood canopy cooling (`−0.8 °C` per `+10%` canopy, capped at `−1.5 °C` with a rural thermal floor) vs. Canopy UHI warming (`+1.8 °C`) on sealed concrete.
    - **☀️ Feel (PET)**: Physiologically Equivalent Temperature modeling solar shielding and evapotranspiration (`−4 to −11 °C` under shade canopy; `+3.5 to +6.0 °C` over unshaded concrete).
    - **🏭 Pollution (PM2.5) & 💧 Humidity**: Models vegetation deposition, SuDS stormwater runoff retention (`−30% to −50%` on unsealed green areas vs. `95%` on sealed concrete), heavy-rain washout (`−90%` coarse PM vs. `−21%` PM2.5), and a **Car-free day** scenario (`−84% NO₂`, `−50% PM10`, `−15% PM2.5`).

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
