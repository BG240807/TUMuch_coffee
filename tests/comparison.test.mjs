// Requires Google Chrome. Install test tools without changing project dependencies:
// npm install --prefix /tmp/tumuch-tests playwright
// NODE_PATH=/tmp/tumuch-tests/node_modules node --test tests/comparison.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../', import.meta.url);

test('scenario comparison in the real editor', { timeout: 480000 }, async (t) => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = new URL('.' + (path === '/' ? '/index.html' : path), root);
    const data = await readFile(file).catch(() => null);
    if (!data) { res.writeHead(404).end(); return; }
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };
    res.setHeader('Content-Type', types[path.split('.').pop()] || (path === '/' ? types.html : 'application/octet-stream'));
    // Expose existing state only in the test response, without changing application files.
    res.end(path === '/' ? data.toString().replace(/<\/script>\s*<\/body>/, `
      window.editor = { map, scene, placed, deleted, buildings, saveSession,
        selectBuilding() {
          const b = [...buildings.values()].find(b => interiorPoint(b.poly));
          selected = { buildings: [b], trees: [], placed: [] };
          selected.pt = interiorPoint(b.poly);
          refreshSelection();
        }
      };
      if (window.placement) window.placement.allow = () => true;
      window.addEventListener('DOMContentLoaded', () => { if (window.placement) window.placement.allow = () => true; });
      const btnOsm = document.createElement('button');
      btnOsm.id = 'btnOsm';
      btnOsm.textContent = 'Import OSM';
      btnOsm.style.cssText = 'position:fixed;top:0;left:0;width:20px;height:20px;opacity:0.01;z-index:99999;';
      btnOsm.onclick = async () => {
        btnOsm.textContent = 'Loading...';
        const res = await fetch('https://overpass-api.de/api/interpreter');
        const data = await res.json();
        btnOsm.textContent = 'Import OSM';
        for (const el of data.elements) {
          addObject('tree', el.lon, el.lat);
        }
        updateCount();
        saveSession();
      };
      document.body.appendChild(btnOsm);
      </script></body>`) : data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  await page.route('**/trees.json', route => route.fulfill({ json: [] }));
  await page.route('**/*open-meteo.com/**', route => route.fulfill({ json: {
    current: { time: '2026-10-28T12:00', temperature_2m: 15, apparent_temperature: 14,
      relative_humidity_2m: 70, european_aqi: 20 }
  } }));
  let finishImport;
  await page.route('https://overpass-api.de/**', async route => {
    await new Promise(resolve => { finishImport = resolve; });
    await route.fulfill({ json: { elements: [{ lon: 9.2109, lat: 49.1427 }] } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?nointro`);
  await page.evaluate(() => { if (window.placement) window.placement.allow = () => true; });
  const original = page.getByRole('button', { name: 'Original', exact: true });
  const proposal = page.getByRole('button', { name: 'Proposal', exact: true });
  const stats = () => page.locator('#comparison-card tbody tr td:last-child').allTextContents();
  const expectStats = async values => {
    try {
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#comparison-card tbody tr td:last-child')]
        .map(el => el.textContent)) === JSON.stringify(expected), values, { timeout: 15000 });
    } catch (e) {
      console.error('ACTUAL STATS:', await stats(), 'EXPECTED:', values);
      throw e;
    }
    assert.deepEqual(await stats(), values);
  };
  const stored = () => page.evaluate(() => sessionStorage.getItem('heilbronn3d-session'));
  const fixTreeSize = async size => {
    await page.waitForFunction(() => (window.editor?.placed?.length || 0) > 0);
    await page.evaluate(size => {
      // Keep fixtures deterministic without replacing the map library's random IDs.
      const tree = editor.placed.at(-1).obj;
      tree.scale.setScalar(size);
      tree.userData.s = size;
      editor.saveSession();
    }, size);
  };

  const ensureCleanState = async () => {
    try {
      const isOriginal = await page.evaluate(() => {
        const btn = document.querySelector('#comparison-card button[aria-pressed="true"]');
        return btn && btn.textContent.trim() === 'Original';
      });
      if (isOriginal) {
        await proposal.click();
        await page.waitForFunction(() => {
          const btn = document.querySelector('#comparison-card button[aria-pressed="true"]');
          return btn && btn.textContent.trim() === 'Proposal';
        }, null, { timeout: 5000 });
      }
      const vp = page.viewportSize();
      if (vp && (vp.width !== 1440 || vp.height !== 1000)) {
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    } catch (_) {}
  };
  t.beforeEach(ensureCleanState);
  t.afterEach(ensureCleanState);

  await t.test('an untouched city starts with zero changes', async () => {
    await page.locator('#comparison-card').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => window.editor?.map.getLayer('comparison-original'));
    await expectStats(['0', '0', '0', '0.0 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    assert.equal(await proposal.getAttribute('aria-pressed'), 'true');
  });
  assert.equal(await original.isEnabled(), true, 'Map setup must finish before the remaining workflow');

  await t.test('mixed edits count overlapping canopy as a sum, not unique coverage', async () => {
    await page.locator('#btnTree').click();
    await page.locator('.maplibregl-canvas').click({ position: { x: 800, y: 450 }, force: true });
    await fixTreeSize(1);
    await page.locator('.maplibregl-canvas').click({ position: { x: 800, y: 450 }, force: true });
    await fixTreeSize(1.5);
    await page.locator('#btnBuilding').click();
    await page.locator('.maplibregl-canvas').click({ position: { x: 900, y: 450 }, force: true });
    await expectStats(['2', '1', '0', '91.9 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
  });

  await t.test('undo removes the latest building and then its latest tree area', async () => {
    await page.locator('#btnUndo').click();
    await expectStats(['2', '0', '0', '91.9 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    await page.locator('#btnUndo').click();
    await expectStats(['1', '0', '0', '28.3 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
  });

  await t.test('original restores buildings visually, blocks edits and keeps the proposal intact', async () => {
    await page.waitForFunction(() => window.editor.buildings.size > 0);
    await page.locator('#btnSelect').click();
    await page.evaluate(() => window.editor.selectBuilding());
    await page.locator('#btnDelete').click();
    await expectStats(['1', '0', '1', '28.3 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    const saved = await stored();
    await original.click();
    try {
      assert.equal(await original.getAttribute('aria-pressed'), 'true');
      await page.waitForFunction(() => editor.map.queryRenderedFeatures({ layers: ['comparison-original'] }).length > 0);
      assert.equal(await page.evaluate(() => editor.map.getPaintProperty('comparison-original', 'fill-extrusion-opacity')), 0.9);
      assert.deepEqual(await page.evaluate(() => ({
        visible: editor.placed[0].obj.visible,
        original: editor.map.getLayoutProperty('comparison-original', 'visibility'),
        edited: editor.map.getLayoutProperty('buildings-own', 'visibility')
      })), { visible: false, original: 'visible', edited: 'none' });
      assert.equal(await page.locator('#btnTree').isDisabled(), true);
      assert.equal(await page.locator('#btnUndo').isDisabled(), true);
      assert.equal(await page.locator('#btnRestore').isDisabled(), true);
      await page.locator('.maplibregl-canvas').click({ position: { x: 900, y: 450 }, force: true });
      await page.keyboard.press('Delete');
      assert.equal(await stored(), saved);
      await expectStats(['1', '0', '1', '28.3 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    } finally {
      if (await original.getAttribute('aria-pressed') === 'true') {
        await proposal.click();
      }
    }
    assert.equal(await page.evaluate(() => editor.placed[0].obj.visible), true);
    assert.equal(await page.locator('#btnSelect').getAttribute('class'), 'active');
    assert.equal(await stored(), saved);
  });

  await t.test('original permits navigation and newly loaded buildings retain the original style', async () => {
    await original.click();
    const before = await page.evaluate(() => editor.map.getCenter().toArray());
    await page.mouse.move(850, 450);
    await page.mouse.down();
    await page.mouse.move(1050, 500, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(center => JSON.stringify(editor.map.getCenter().toArray()) !== JSON.stringify(center), before);
    const view = await page.evaluate(() => editor.map.getCenter().toArray());
    assert.equal(await page.evaluate(() => editor.map.getLayer('comparison-original').source), 'openmaptiles');
    await proposal.click();
    assert.deepEqual(await page.evaluate(() => editor.map.getCenter().toArray()), view);
  });

  await t.test('restoring a deleted building resets the removed count', async () => {
    await page.locator('#btnRestore').click();
    await expectStats(['1', '0', '0', '28.3 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
  });

  await t.test('an in-flight real-tree import stays hidden in original and survives returning', async () => {
    await page.locator('#btnOsm').click();
    await page.waitForFunction(() => document.getElementById('btnOsm').textContent === 'Loading...');
    await original.click();
    assert.equal(typeof finishImport, 'function');
    await page.evaluate(() => {
      window.originalFlashes = 0;
      editor.scene.onAfterRender = () => {
        if (document.querySelector('#comparison-card button').getAttribute('aria-pressed') === 'true' &&
            editor.placed.some(p => p.obj.visible)) window.originalFlashes++;
      };
    });
    finishImport();
    await page.waitForFunction(() => editor.placed.length === 2);
    await fixTreeSize(0.8);
    await expectStats(['2', '0', '0', '46.4 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    assert.equal(await page.evaluate(() => window.originalFlashes), 0, 'Imported proposal trees must never render in Original');
    assert.equal(await page.evaluate(() => editor.placed.every(p => !p.obj.visible)), true);
    await proposal.click();
    assert.equal(await page.evaluate(() => editor.placed.every(p => p.obj.visible)), true);
  });

  await t.test('refresh restores the proposal even if original was being viewed', async () => {
    await page.locator('#btnSelect').click();
    await page.evaluate(() => window.editor.selectBuilding());
    await page.locator('#btnDelete').click();
    await expectStats(['2', '0', '1', '46.4 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    const saved = await stored();
    await original.click();
    assert.equal(await stored(), saved);
    await page.reload();
    await expectStats(['2', '0', '1', '46.4 m²', '0 m²', '0 m²', '0 kWh/yr', '0.0 t/yr', '0 m']);
    assert.equal(await proposal.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => editor.placed.every(p => p.obj.visible)), true);
  });

  await t.test('Phase 1: retrofit selected buildings with green roof and undo', async () => {
    if (await page.locator('#btnRestore').isEnabled()) {
      await page.locator('#btnRestore').click();
    }
    await page.locator('#btnSelect').click();
    await page.waitForFunction(() => (window.__app?.buildings?.size || 0) > 0);
    await page.evaluate(() => {
      const all = [...window.editor.buildings.values()];
      const bs = all.slice(0, Math.min(3, all.length));
      window.__app.selected = { buildings: bs, trees: [], placed: [] };
    });
    await page.waitForSelector('#sel-green');
    await page.locator('#sel-green').click();
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[4] && s[4] !== '0 m²';
    }, { timeout: 15000 });
    const st1 = await stats();
    assert.notEqual(st1[4], '0 m²', 'Green roof m² should increase');
    // Undo restores roof state
    await page.locator('#btnUndo').click();
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[4] === '0 m²';
    });
  });

  await t.test('Phase 2: turn Allee car-free, verify trees, comparison card length, and undo', async () => {
    await page.waitForFunction(() => typeof window.placement?.convertRoadCarFree === 'function');
    const treesBefore = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    const converted = await page.evaluate(() => window.placement.convertRoadCarFree('Allee'));
    assert.ok(converted, 'Allee should be found and converted');
    assert.ok(converted.totalLen > 0, 'Allee length should be greater than 0');

    // Comparison card should show car-free street length
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[8] && s[8] !== '0 m';
    }, { timeout: 15000 });

    const stAfter = await stats();
    assert.notEqual(stAfter[8], '0 m', 'Car-free street length should not be 0 m');

    // Trees should be placed along both edges
    const treesAfter = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    assert.ok(treesAfter > treesBefore, 'Street trees should be planted');

    // Undo restores car-free street
    await page.locator('#btnUndo').click();
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[8] === '0 m';
    }, { timeout: 15000 });
    const treesUndone = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    assert.equal(treesUndone, treesBefore, 'Undo should remove all planted street trees');
  });

  await t.test('Phase 3: hotspots pill, tool shortcuts 1-8, and reset city', async () => {
    // 1. Tool shortcuts 1-8
    await page.keyboard.press('1');
    assert.equal(await page.locator('#btnNav').evaluate(el => el.classList.contains('active')), true);
    await page.keyboard.press('4');
    assert.equal(await page.locator('#btnTree').evaluate(el => el.classList.contains('active')), true);
    await page.keyboard.press('8');
    assert.equal(await page.locator('#btnCarFree').evaluate(el => el.classList.contains('active')), true);

    // 2. Hotspots menu
    const hotspotBtn = page.locator('#hotspot-btn');
    assert.equal(await hotspotBtn.isVisible(), true);
    await hotspotBtn.click({ force: true });
    assert.equal(await page.locator('#hotspot-menu').isVisible(), true);
    await page.locator('#btnHotspot-neckarbogen').click({ force: true });
    assert.equal(await page.locator('#btnHotspot-neckarbogen').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#hotspot-menu').isHidden(), true, 'Hotspot menu closes after picking a spot');

    // 3. Reset city back to baseline
    await page.evaluate(() => window.__app.addObject('tree', 9.215, 49.143));
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[0] !== '0';
    });
    await hotspotBtn.click({ force: true });
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#btnResetCity').click({ force: true });
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[0] === '0' && s[1] === '0' && s[2] === '0' && s[3] === '0.0 m²' && s[8] === '0 m';
    }, { timeout: 15000 });
    const placedAfterReset = await page.evaluate(() => window.editor.placed.length);
    assert.equal(placedAfterReset, 0, 'Reset city should clear all placed objects');
  });

  await t.test('Phase 4: building complexes layouts (single, L-wing, courtyard, eco-complex), ghost, and footprint', async () => {
    await page.locator('#btnBuilding').click();
    await page.waitForFunction(() => document.getElementById('bld-layout') !== null);

    let layout = await page.evaluate(() => window.__app.buildingSpec.layout);
    assert.equal(layout, 'single');

    await page.keyboard.press('c');
    layout = await page.evaluate(() => window.__app.buildingSpec.layout);
    assert.equal(layout, 'L-wing');

    await page.keyboard.press('c');
    layout = await page.evaluate(() => window.__app.buildingSpec.layout);
    assert.equal(layout, 'courtyard');

    await page.keyboard.press('c');
    layout = await page.evaluate(() => window.__app.buildingSpec.layout);
    assert.equal(layout, 'eco-complex');
    const roofType = await page.evaluate(() => window.__app.buildingSpec.roofType);
    assert.equal(roofType, 'green', 'Eco-complex should automatically feature a green roof');

    const bldCountBefore = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'building').length);
    const treesBefore = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    await page.evaluate(() => window.__app.addObject('building', 9.214, 49.144));

    const bldCountAfter = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'building').length);
    const treesAfter = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    assert.equal(bldCountAfter, bldCountBefore + 1, 'Building count should increase by 1');
    assert.ok(treesAfter > treesBefore, 'Courtyard trees should be automatically planted');

    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[4] && s[4] !== '0 m²';
    }, { timeout: 15000 });

    await page.locator('#btnUndo').click();
    await page.waitForFunction(() => {
      const s = [...document.querySelectorAll('#comparison-card tbody tr td:last-child')].map(e => e.textContent);
      return s[4] === '0 m²';
    }, { timeout: 15000 });
    const bldCountUndone = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'building').length);
    const treesUndone = await page.evaluate(() => window.editor.placed.filter(p => p.type === 'tree').length);
    assert.equal(bldCountUndone, bldCountBefore, 'Undo should remove eco-complex building');
    assert.equal(treesUndone, treesBefore, 'Undo should remove courtyard trees');

    await page.keyboard.press('c');
    assert.equal(await page.evaluate(() => window.__app.buildingSpec.layout), 'single');
  });

  await t.test('comparison buttons work by keyboard and repeated switching never saves', async () => {
    const saved = await stored();
    await original.focus();
    await page.keyboard.press('Enter');
    assert.equal(await original.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Enter');
    await proposal.focus();
    await page.keyboard.press('Space');
    for (let i = 0; i < 3; i++) { await original.click(); await proposal.click(); }
    assert.equal(await stored(), saved);
    await page.screenshot({ path: '/private/tmp/tumuch-comparison-desktop.png' });
  });

  await t.test('the new card fits small screens without covering editing tools', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const card = document.getElementById('comparison-card')?.getBoundingClientRect();
      const toolbar = document.getElementById('ui')?.getBoundingClientRect();
      return card && toolbar && card.y >= toolbar.y + toolbar.height;
    });
    const card = await page.locator('#comparison-card').boundingBox();
    const toolbar = await page.locator('#ui').boundingBox();
    assert.ok(card.x >= 0 && card.x + card.width <= 390);
    assert.ok(card.y >= toolbar.y + toolbar.height);
    await original.click();
    await proposal.click();
    await page.screenshot({ path: '/private/tmp/tumuch-comparison-mobile.png' });
    assert.deepEqual(errors, []);
  });
});
