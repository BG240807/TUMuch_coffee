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

test('scenario comparison in the real editor', { timeout: 180000 }, async (t) => {
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
          selected = [...buildings.values()].find(b => interiorPoint(b.poly));
          selected.pt = interiorPoint(selected.poly);
          refreshSelection();
        }
      };
      </script></body>`) : data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader'] });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const original = page.getByRole('button', { name: 'Original', exact: true });
  const proposal = page.getByRole('button', { name: 'Proposal', exact: true });
  const stats = () => page.locator('#comparison-card tbody tr td:last-child').allTextContents();
  const expectStats = async values => {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#comparison-card tbody tr td:last-child')]
      .map(el => el.textContent)) === JSON.stringify(expected), values);
    assert.deepEqual(await stats(), values);
  };
  const stored = () => page.evaluate(() => sessionStorage.getItem('heilbronn3d-session'));
  const fixTreeSize = size => page.evaluate(size => {
    // Keep fixtures deterministic without replacing the map library's random IDs.
    const tree = editor.placed.at(-1).obj;
    tree.scale.setScalar(size);
    tree.userData.s = size;
    editor.saveSession();
  }, size);

  await t.test('an untouched city starts with zero changes', async () => {
    await page.locator('#comparison-card').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => window.editor?.map.getLayer('comparison-original'));
    await expectStats(['0', '0', '0', '0.0 m²']);
    assert.equal(await proposal.getAttribute('aria-pressed'), 'true');
  });
  assert.equal(await original.isEnabled(), true, 'Map setup must finish before the remaining workflow');

  await t.test('mixed edits count overlapping canopy as a sum, not unique coverage', async () => {
    await page.locator('#btnTree').click();
    await page.locator('canvas').click({ position: { x: 800, y: 450 } });
    await fixTreeSize(1);
    await page.locator('canvas').click({ position: { x: 800, y: 450 } });
    await fixTreeSize(1.5);
    await page.locator('#btnBuilding').click();
    await page.locator('canvas').click({ position: { x: 900, y: 450 } });
    await expectStats(['2', '1', '0', '91.9 m²']);
  });

  await t.test('undo removes the latest building and then its latest tree area', async () => {
    await page.locator('#btnUndo').click();
    await expectStats(['2', '0', '0', '91.9 m²']);
    await page.locator('#btnUndo').click();
    await expectStats(['1', '0', '0', '28.3 m²']);
  });

  await t.test('original restores buildings visually, blocks edits and keeps the proposal intact', async () => {
    await page.waitForFunction(() => window.editor.buildings.size > 0);
    await page.locator('#btnSelect').click();
    await page.evaluate(() => window.editor.selectBuilding());
    await page.locator('#btnDelete').click();
    await expectStats(['1', '0', '1', '28.3 m²']);
    const saved = await stored();
    await original.click();
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
    await page.locator('canvas').click({ position: { x: 900, y: 450 } });
    await page.keyboard.press('Delete');
    assert.equal(await stored(), saved);
    await expectStats(['1', '0', '1', '28.3 m²']);
    await proposal.click();
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
    await expectStats(['1', '0', '0', '28.3 m²']);
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
    await expectStats(['2', '0', '0', '46.4 m²']);
    assert.equal(await page.evaluate(() => window.originalFlashes), 0, 'Imported proposal trees must never render in Original');
    assert.equal(await page.evaluate(() => editor.placed.every(p => !p.obj.visible)), true);
    await proposal.click();
    assert.equal(await page.evaluate(() => editor.placed.every(p => p.obj.visible)), true);
  });

  await t.test('refresh restores the proposal even if original was being viewed', async () => {
    await page.locator('#btnSelect').click();
    await page.evaluate(() => window.editor.selectBuilding());
    await page.locator('#btnDelete').click();
    await expectStats(['2', '0', '1', '46.4 m²']);
    const saved = await stored();
    await original.click();
    assert.equal(await stored(), saved);
    await page.reload();
    await expectStats(['2', '0', '1', '46.4 m²']);
    assert.equal(await proposal.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => editor.placed.every(p => p.obj.visible)), true);
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
