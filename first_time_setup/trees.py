"""
Convert the Heilbronn tree cadastre shapefile (.shp/.shx/.dbf/.prj/.cpg)
into a compact trees.json that index.html can load.

Usage:
    pip install geopandas
    python convert_trees.py path/to/Baumkataster.shp [trees.json]

Output: a JSON array of rows
    [lng, lat, typeCode, crownDiameter, trunkCircumference, deuText, wisText, street, baumNr]
typeCode: 0 deciduous, 1 coniferous, 2 fruit, 3 group of trees, 4 unknown
"""
import json
import sys

import geopandas as gpd
import pandas as pd


def type_code(typ):
    t = str(typ or "").lower()
    if "laub" in t or "decid" in t:
        return 0
    if "nadel" in t or "conif" in t:
        return 1
    if "obst" in t or "fruit" in t:
        return 2
    if "gruppe" in t or "group" in t:
        return 3
    return 4


def num(v, default=0.0):
    try:
        f = float(v)
        return default if pd.isna(f) else round(f, 2)
    except (TypeError, ValueError):
        return default


def txt(v):
    return "" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v)


def convert(shp_path, out_path="trees.json"):
    gdf = gpd.read_file(shp_path, encoding="utf-8")  # .cpg says UTF-8
    geom_name = gdf.geometry.name
    gdf = gdf.rename(columns={c: c.upper() for c in gdf.columns if c != geom_name})

    if gdf.crs is None:  # no .prj? the city publishes EPSG:25832
        gdf = gdf.set_crs(25832)
    gdf = gdf.to_crs(4326)  # works for both 25832 and 4326 input

    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty]
    gdf = gdf.explode(index_parts=False)
    gdf = gdf[gdf.geom_type == "Point"]

    rows = []
    for _, r in gdf.iterrows():
        rows.append([
            round(r.geometry.x, 6),
            round(r.geometry.y, 6),
            type_code(r.get("TYP")),
            num(r.get("KRONE_DM")),
            num(r.get("ST_UMFANG")),
            txt(r.get("DEU_TEXT")),
            txt(r.get("WIS_TEXT")),
            txt(r.get("STRASSE")),
            txt(r.get("BAUM_NR")),
        ])

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(rows)} trees to {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    convert(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "trees.json")