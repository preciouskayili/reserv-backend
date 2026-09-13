import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

// A clean environment ensures tests cannot contact configured email, call or database services.
test('API protects private routes and validates booking input', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '4198', DOTENV_CONFIG_PATH: '/dev/null', ENABLE_CALL_SCHEDULER: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API failed to start')), 10000);
      child.stdout.on('data', (data) => { if (data.toString().includes('Reserv Backend running')) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`API exited: ${code}`)); });
    });
    const request = (path, method = 'GET', body) => fetch(`http://localhost:4198${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const [path, method] of [['/api/bookings','GET'], ['/api/bookings/ABC123','GET'], ['/api/bookings/ABC123','PATCH'], ['/api/calls','GET'], ['/api/calls/trigger','POST'], ['/api/calls/example','GET'], ['/api/upload','POST'], ['/api/calls/webhook','POST']]) {
      assert.equal((await request(path, method, method === 'GET' ? undefined : {})).status, 401, `${method} ${path}`);
    }
    assert.equal((await request('/api/bookings', 'POST', {})).status, 400);
    assert.equal((await request('/api/bookings', 'POST', { customerId: 'a', serviceId: 'b', staffId: 'c', startTime: '2026-10-01T12:00:00Z', endTime: '2026-10-01T11:00:00Z' })).status, 400);
    const malformed = await fetch('http://localhost:4198/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type'), /application\/json/);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
});

test('production rejects development authentication defaults', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/dev/null' }, stdio: 'pipe',
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(errors, /Production requires a strong JWT_SECRET/);
});
