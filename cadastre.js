// Renders the Heilbronn tree cadastre (trees.json) with instanced meshes.
// Only trees inside the camera frustum (and within maxDistance) are drawn:
// per-tree matrices are precomputed once, and the visible ones are packed
// into the instance buffers whenever the camera changes.
const TYPE_NAMES = ['Laubbaum', 'Nadelbaum', 'Obstbaum', 'Baumgruppe', 'Unbekannt'];
const COLORS = [0x388e3c, 0x1b5e20, 0x7cb342, 0x2e7d32, 0x66bb6a];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export async function addCadastre({
  THREE, map, scene, toScene, url = 'trees.json',
  fixDefaultCrowns = false, sizeScale = 0.6, maxCrown = 12,
  maxDistance = 900,      // meters from the camera; trees farther away are skipped
  cullInterval = 100,     // ms; minimum time between culling passes while moving
  debug = false           // log culling stats to the console
}) {
  const rows = await (await fetch(url)).json();
  const n = rows.length;

  // per-tree geometry parameters
  const T = rows.map((r, idx) => {
    const [lng, lat, typ, crownIn, circ] = r;
    let crown = crownIn > 0 ? crownIn : 3;
    // The cadastre uses a 2 m default crown for trees outside the city's
    // inspection program; estimate from trunk circumference instead.
    if (fixDefaultCrowns && crown <= 2 && typ !== 3 && circ > 0.6) {
      crown = clamp(3 + 3 * circ, 3, 14);
    }
    crown = Math.min(crown, maxCrown) * sizeScale; // global size knob
    const conifer = typ === 1;
    const H = conifer ? clamp(4 + crown * 1.6, 4, 25) : clamp(3 + crown * 0.9, 3.5, 22);
    const trunkH = conifer ? H * 0.15 : H * 0.4;
    const trunkR = typ === 3 ? 0.2 : clamp(circ / (2 * Math.PI), 0.1, 0.8);
    const p = toScene(lng, lat, 0);
    const rad = Math.max(crown / 2, H / 2) + 1; // bounding-sphere radius for culling
    return { idx, x: p.x, z: p.z, lng, lat, typ, crown, H, trunkH, trunkR, rad, elev: map.transform.elevation || 0 };
  });

  const nConifer = T.filter(t => t.typ === 1).length;
  const nOther = n - nConifer;

  // meshes (capacity = all trees; `count` is set to the visible number)
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.8, 1, 1, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), Math.max(1, n));
  const crownMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, Math.max(1, nOther));
  const coneMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), mat.clone(), Math.max(1, nConifer));
  const meshes = [trunkMesh, crownMesh, coneMesh];
  meshes.forEach(m => { m.count = 0; m.frustumCulled = false; scene.add(m); });
  const white = new THREE.Color(1, 1, 1);
  crownMesh.setColorAt(0, white); // creates the instanceColor buffers
  coneMesh.setColorAt(0, white);

  // precomputed per-tree data (indexed by tree idx)
  const trunkM = new Float32Array(n * 16);
  const crownM = new Float32Array(n * 16); // crown or cone matrix, depending on type
  const colors = new Float32Array(n * 3);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let dirty = true;

  function place(t) {
    dummy.rotation.set(0, 0, 0);
    // trunk
    dummy.position.set(t.x, t.elev + t.trunkH / 2, t.z);
    dummy.scale.set(t.trunkR, t.trunkH, t.trunkR);
    dummy.updateMatrix();
    dummy.matrix.toArray(trunkM, t.idx * 16);
    // crown
    const r = t.crown / 2;
    if (t.typ === 1) {
      const ch = t.H - t.trunkH;
      dummy.position.set(t.x, t.elev + t.trunkH + ch / 2, t.z);
      dummy.scale.set(r, ch, r);
    } else {
      const vr = (t.H - t.trunkH) / 2;
      dummy.position.set(t.x, t.elev + t.trunkH + vr * 0.9, t.z);
      dummy.scale.set(r, vr, r);
    }
    dummy.updateMatrix();
    dummy.matrix.toArray(crownM, t.idx * 16);
  }

  T.forEach(t => {
    place(t);
    color.setHex(COLORS[t.typ]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
    color.toArray(colors, t.idx * 3);
  });

  // ---------- culling ----------
  const frustum = new THREE.Frustum();
  const prevProj = new Float32Array(16);
  let lastCull = -Infinity;
  let visibleCount = 0;

  function copy16(src, si, dst, di) {
    for (let k = 0; k < 16; k++) dst[di + k] = src[si + k];
  }

  function upload(mesh, count) {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // Call once per frame (from the custom layer's render) with the three camera
  // whose projectionMatrix was just set. Cheap when nothing changed.
  let warned = false;
  function update(camera, now) {
    try {
      cull(camera, now ?? performance.now());
    } catch (err) {
      if (!warned) { console.error('cadastre culling failed:', err); warned = true; }
    }
  }

  function cull(camera, now) {
    const pm = camera.projectionMatrix.elements;
    let same = true;
    for (let i = 0; i < 16; i++) if (pm[i] !== prevProj[i]) { same = false; break; }
    if (same && !dirty) return;
    if (!dirty && now - lastCull < cullInterval) return;
    prevProj.set(pm);
    lastCull = now;
    dirty = false;

    frustum.setFromProjectionMatrix(camera.projectionMatrix);
    const planes = frustum.planes;
    const sceneY = -(map.transform.elevation || 0); // same shift as scene.position.y in index.html

    let cp;
    try { cp = map.getFreeCameraOptions().position.toLngLat(); } catch { cp = map.getCenter(); }
    const cam = toScene(cp.lng, cp.lat, 0);
    let passDist = 0;
    const maxD2 = maxDistance * maxDistance;

    const tA = trunkMesh.instanceMatrix.array;
    const cA = crownMesh.instanceMatrix.array, cC = crownMesh.instanceColor.array;
    const kA = coneMesh.instanceMatrix.array, kC = coneMesh.instanceColor.array;
    let nt = 0, nc = 0, nk = 0;

    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t.hidden) continue;
      const dx = t.x - cam.x, dz = t.z - cam.z;
      if (dx * dx + dz * dz > maxD2) continue;
      passDist++;
      const y = t.elev + sceneY + t.H / 2;
      let inside = true;
      for (let p = 0; p < 6; p++) {
        const pl = planes[p];
        if (pl.normal.x * t.x + pl.normal.y * y + pl.normal.z * t.z + pl.constant < -t.rad) {
          inside = false; break;
        }
      }
      if (!inside) continue;

      copy16(trunkM, i * 16, tA, nt * 16); nt++;
      if (t.typ === 1) {
        copy16(crownM, i * 16, kA, nk * 16);
        kC[nk * 3] = colors[i * 3]; kC[nk * 3 + 1] = colors[i * 3 + 1]; kC[nk * 3 + 2] = colors[i * 3 + 2];
        nk++;
      } else {
        copy16(crownM, i * 16, cA, nc * 16);
        cC[nc * 3] = colors[i * 3]; cC[nc * 3 + 1] = colors[i * 3 + 1]; cC[nc * 3 + 2] = colors[i * 3 + 2];
        nc++;
      }
    }
    upload(trunkMesh, nt);
    upload(crownMesh, nc);
    upload(coneMesh, nk);
    visibleCount = nt;
    if (debug) {
      console.log(`cadastre: ${n} trees, ${passDist} within ${maxDistance} m, ${nt} in frustum`,
        { camera: [cam.x.toFixed(0), cam.z.toFixed(0)] });
    }
  }

  // ---------- terrain heights (only trees near the view are sampled) ----------
  // The terrain mesh changes resolution as you zoom, so re-sample elevations
  // for trees in view whenever the map goes idle to keep them on the ground.
  function refreshHeights() {
    const b = map.getBounds();
    const padLng = (b.getEast() - b.getWest()) * 0.25;
    const padLat = (b.getNorth() - b.getSouth()) * 0.25;
    for (const t of T) {
      if (t.lng < b.getWest() - padLng || t.lng > b.getEast() + padLng ||
          t.lat < b.getSouth() - padLat || t.lat > b.getNorth() + padLat) continue;
      const rel = map.queryTerrainElevation([t.lng, t.lat]);
      if (rel == null) continue;
      const e = rel + (map.transform.elevation || 0); // absolute height (rel is relative to the screen centre)
      if (Math.abs(e - t.elev) < 0.25) continue;
      t.elev = e;
      place(t);
      dirty = true;
    }
  }
  // 'idle' fires every frame (the custom layer keeps repainting), so only re-sample
  // after the view moved or new terrain tiles arrived.
  let heightsStale = true;
  map.on('moveend', () => { heightsStale = true; });
  map.on('sourcedata', (e) => { if (e.sourceId === 'terrain') heightsStale = true; });
  map.on('idle', () => { if (heightsStale) { heightsStale = false; refreshHeights(); } });

  // nearest cadastre tree within `radius` meters of a clicked point
  function inspect(lngLat, radius = 6) {
    const p = toScene(lngLat.lng, lngLat.lat, 0);
    let best = null, bd = radius * radius;
    for (let i = 0; i < n; i++) {
      const dx = T[i].x - p.x, dz = T[i].z - p.z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (best == null) return null;
    const [lng, lat, typ, crown, circ, deu, wis, street, nr] = rows[best];
    return {
      lngLat: [lng, lat],
      html: `<b>${deu || 'Unbekannt'}</b><br><i>${wis}</i><br>` +
        `${TYPE_NAMES[typ]}${street ? ' · ' + street : ''}<br>` +
        `Stammumfang: ${circ} m${typ === 3 ? ' (Summe)' : ''}<br>` +
        `Krone: ${crown} m<br><small>Nr. ${nr}</small>`
    };
  }

  // ---------- selection / deletion support ----------
  // Ray (scene coordinates, metres) vs every visible tree, modelled as a crown ellipsoid
  // plus a trunk cylinder. Returns { index, t } for the nearest hit, or null.
  function pick(o, d) {
    let best = -1, bestT = Infinity;
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (t.hidden) continue;
      let hit = Infinity;

      // crown: ellipsoid
      const r = Math.max(t.crown / 2, 0.3);
      const vr = (t.H - t.trunkH) / 2;
      const cy = t.elev + t.trunkH + (t.typ === 1 ? vr : vr * 0.9);
      const ox = (o.x - t.x) / r, oy = (o.y - cy) / vr, oz = (o.z - t.z) / r;
      const dx = d.x / r, dy = d.y / vr, dz = d.z / r;
      const a = dx * dx + dy * dy + dz * dz;
      const b = ox * dx + oy * dy + oz * dz;
      const cc = ox * ox + oy * oy + oz * oz - 1;
      const disc = b * b - a * cc;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const t1 = (-b - sq) / a, t2 = (-b + sq) / a;
        if (t1 > 0) hit = t1; else if (t2 > 0) hit = t2;
      }

      // trunk: vertical cylinder (a little wider than drawn so it is clickable)
      const tr = Math.max(t.trunkR, 0.4);
      const px = o.x - t.x, pz = o.z - t.z;
      const a2 = d.x * d.x + d.z * d.z;
      if (a2 > 1e-9) {
        const b2 = px * d.x + pz * d.z, c2 = px * px + pz * pz - tr * tr;
        const disc2 = b2 * b2 - a2 * c2;
        if (disc2 >= 0) {
          const tt = (-b2 - Math.sqrt(disc2)) / a2;
          const y = o.y + d.y * tt;
          if (tt > 0 && y >= t.elev && y <= t.elev + t.trunkH && tt < hit) hit = tt;
        }
      }

      if (hit < bestT) { bestT = hit; best = i; }
    }
    return best < 0 ? null : { index: best, t: bestT };
  }
  function info(i) {
    const t = T[i];
    return { x: t.x, z: t.z, elev: t.elev, H: t.H, crown: t.crown, trunkH: t.trunkH, row: rows[i] };
  }
  function hide(i) { if (T[i]) { T[i].hidden = true; dirty = true; } }
  function show(i) { if (T[i]) { T[i].hidden = false; dirty = true; } }

  return {
    count: n,
    get visibleCount() { return visibleCount; },
    update,
    inspect,
    pick, info, hide, show,
    setVisible(v) { meshes.forEach(m => { m.visible = v; }); }
  };
}