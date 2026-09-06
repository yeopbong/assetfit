import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { serve } from '../src/server.mjs';

test('local API rejects foreign Host and Origin headers and has no arbitrary file import endpoint', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'assetfit-server-'));
  const port = 49000 + Math.floor(Math.random() * 10000);
  const service = await serve({ root, port });
  await new Promise((resolve, reject) => { if (service.server.listening) resolve(); else { service.server.once('listening', resolve); service.server.once('error', reject); } });
  t.after(async () => { await new Promise((resolve) => service.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(service.server.address().address, '127.0.0.1');
  await assert.rejects(serve({ root, port }), /already in use.*pnpm start --port/);
  await assert.rejects(serve({ root, port: NaN }), /between 1 and 65535/);
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/health', { headers: { Host: 'attacker.invalid' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(origin + '/api/projects', { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.deepEqual(await (await fetch(origin + '/api/projects')).json(), []);
  const created = await (await fetch(origin + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ name: 'HTTP smoke test' }) })).json();
  assert.ok(created.id);
  assert.equal((await fetch(origin + `/api/projects/${created.id}/import-path`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/etc/passwd' }) })).status, 404);
  assert.equal((await fetch(origin + `/files/${created.id}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  assert.equal((await fetch(origin + `/api/projects/${created.id}`)).status, 200);
});
