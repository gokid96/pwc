import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sourceDirectory } from './fixtures/source-directory.mjs';
import { createDemoWorkflow } from '../src/demo-session.mjs';
import { calculateW07, readW07Data } from '../src/w07.mjs';

test('reset only clears the current demo session', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.TEST_DATABASE_URL).hostname));
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const data = await readW07Data(sourceDirectory);
  const workflow = createDemoWorkflow(pool, async () => data, calculateW07, 'local-test');
  const server = createServer((req, res) => workflow(req, res).catch(error => {
    res.writeHead(500).end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + server.address().port;
  const catalog = root + '/?view=catalog&period=2026-06';
  try {
    const entry = await (await fetch(root)).text();
    assert.match(entry, /판매장려금 운영/);
    assert.doesNotMatch(entry, /view=demo|시연 시작/);
    const start = await fetch(root + '/?view=roles&select=1&period=2026-06', {
      method: 'POST', redirect: 'manual',
    });
    assert.equal(start.status, 303);
    const cookie = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const page = await fetch(root + '/?view=requests&period=2026-06&group=D-011', { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /view=roles&amp;period=2026-06&amp;case=D-011/);
    const changeRole = await fetch(root + '/?view=roles&select=0&period=2026-06&case=D-011', {
      headers: { cookie }, method: 'POST', redirect: 'manual',
    });
    assert.equal(changeRole.status, 303);
    const session = cookie.split('; ').find(value => value.startsWith('w07_demo='));
    const role = changeRole.headers.getSetCookie().find(value => value.startsWith('w07_role=')).split(';')[0];
    const next = await fetch(root + changeRole.headers.get('location'), {
      headers: { cookie: session + '; ' + role }, redirect: 'manual',
    });
    assert.equal(next.status, 303);
    assert.equal(next.headers.get('location'), '/?period=2026-06&view=requests&group=D-011');

    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const start = await fetch(root + '/?view=roles&select=4', { method: 'POST', redirect: 'manual' });
      assert.equal(start.status, 303);
      const cookie = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const schema = 'w07_demo_' + cookie.match(/w07_demo=([a-f0-9]{32})/)[1];
      const page = await fetch(catalog, { headers: { cookie } });
      assert.equal(page.status, 200, await page.text());
      await pool.query(`INSERT INTO ${schema}.w07_event (period,group_id,role,action,reason)
        VALUES ('2026-06','D-011','test','test','test')`);
      sessions.push({ cookie, schema });
    }

    const reset = await fetch(catalog, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: sessions[0].cookie },
      body: new URLSearchParams({ action: 'reset', confirm: '2026-06 초기화' }),
    });
    assert.equal(reset.status, 303, await reset.text());
    for (const [index, { schema }] of sessions.entries()) {
      const { rows } = await pool.query(`SELECT count(*)::int AS count FROM ${schema}.w07_event`);
      assert.equal(rows[0].count, index);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
