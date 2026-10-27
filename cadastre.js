// Renders the Heilbronn tree cadastre (trees.json) with instanced meshes,
// so tens of thousands of trees stay smooth.
const TYPE_NAMES = ['Laubbaum', 'Nadelbaum', 'Obstbaum', 'Baumgruppe', 'Unbekannt'];
const COLORS = [0x388e3c, 0x1b5e20, 0x7cb342, 0x2e7d32, 0x66bb6a];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export async function addCadastre({ THREE, map, scene, toScene, url = 'trees.json', fixDefaultCrowns = false, sizeScale = 0.6, maxCrown = 12 }) {
  const rows = await (await fetch(url)).json();
  const n = rows.length;

  // per-tree geometry parameters
  const T = rows.map(r => {
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
    return { x: p.x, z: p.z, lng, lat, typ, crown, H, trunkH, trunkR, elev: 0, resolved: false };
  });

  const conifers = T.filter(t => t.typ === 1);
  const others = T.filter(t => t.typ !== 1);

  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.8, 1, 1, 6), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), n);
  const crownMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, others.length);
  const coneMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), mat.clone(), conifers.length);
  [trunkMesh, crownMesh, coneMesh].forEach(m => { m.frustumCulled = false; scene.add(m); });

  others.forEach((t, i) => { t.slot = i; });
  conifers.forEach((t, i) => { t.slot = i; });
  T.forEach((t, i) => { t.idx = i; });

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  function place(t) {
    // trunk
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, t.elev + t.trunkH / 2, t.z);
    dummy.scale.set(t.trunkR, t.trunkH, t.trunkR);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(t.idx, dummy.matrix);
    // crown
    const r = t.crown / 2;
    if (t.typ === 1) {
      const ch = t.H - t.trunkH;
      dummy.position.set(t.x, t.elev + t.trunkH + ch / 2, t.z);
      dummy.scale.set(r, ch, r);
      dummy.updateMatrix();
      coneMesh.setMatrixAt(t.slot, dummy.matrix);
    } else {
      const vr = (t.H - t.trunkH) / 2;
      dummy.position.set(t.x, t.elev + t.trunkH + vr * 0.9, t.z);
      dummy.scale.set(r, vr, r);
      dummy.updateMatrix();
      crownMesh.setMatrixAt(t.slot, dummy.matrix);
    }
  }

  T.forEach(t => {
    place(t);
    color.setHex(COLORS[t.typ]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
    (t.typ === 1 ? coneMesh : crownMesh).setColorAt(t.slot, color);
  });
  [trunkMesh, crownMesh, coneMesh].forEach(m => { m.instanceMatrix.needsUpdate = true; });
  crownMesh.instanceColor.needsUpdate = true;
  if (coneMesh.instanceColor) coneMesh.instanceColor.needsUpdate = true;

  // The terrain mesh changes resolution as you zoom, so re-sample elevations
  // for trees in view whenever the map goes idle to keep them on the ground.
  function refreshHeights() {
    const b = map.getBounds();
    const padLng = (b.getEast() - b.getWest()) * 0.25;
    const padLat = (b.getNorth() - b.getSouth()) * 0.25;
    let changed = false;
    for (const t of T) {
      if (t.lng < b.getWest() - padLng || t.lng > b.getEast() + padLng ||
          t.lat < b.getSouth() - padLat || t.lat > b.getNorth() + padLat) continue;
      const e = map.queryTerrainElevation([t.lng, t.lat]);
      if (e == null || Math.abs(e - t.elev) < 0.25) continue;
      t.elev = e;
      place(t);
      changed = true;
    }
    if (changed) {
      trunkMesh.instanceMatrix.needsUpdate = true;
      crownMesh.instanceMatrix.needsUpdate = true;
      coneMesh.instanceMatrix.needsUpdate = true;
    }
  }
  map.on('idle', refreshHeights);
  refreshHeights();

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

  return { count: n, inspect, setVisible(v) { [trunkMesh, crownMesh, coneMesh].forEach(m => { m.visible = v; }); } };
}