import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

// A clean environment ensures tests cannot contact configured email, call or database services.
test('API protects private routes and validates booking input', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '4198', PAYSTACK_SECRET_KEY: 'sk_test_http_fixture', AETHEX_WEBHOOK_SECRET: 'voice-test-secret', DOTENV_CONFIG_PATH: '/dev/null', ENABLE_CALL_SCHEDULER: 'false' },
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
    for (const [path, method] of [['/api/bookings','GET'], ['/api/bookings/ABC123','GET'], ['/api/bookings/ABC123','PATCH'], ['/api/calls','GET'], ['/api/calls/trigger','POST'], ['/api/calls/example','GET'], ['/api/upload','POST'], ['/api/calls/webhook','POST'], ['/api/voice/tools/abc/get_business_info','POST']]) {
      assert.equal((await request(path, method, method === 'GET' ? undefined : {})).status, 401, `${method} ${path}`);
    }
    assert.equal((await request('/api/bookings', 'POST', {})).status, 401);
    assert.equal((await request('/api/calls/status')).status, 401);
    assert.equal((await request('/api/calls/cron/reminders', 'POST', {})).status, 503, 'unconfigured cron must not report success');
    assert.equal((await request('/api/bookings', 'POST', { customerId: 'a', serviceId: 'b', staffId: 'c', startTime: '2026-10-01T12:00:00Z', endTime: '2026-10-01T11:00:00Z' })).status, 401);
    const malformed = await fetch('http://localhost:4198/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type'), /application\/json/);
    const options = await request('/api/payments/options');
    assert.deepEqual((await options.json()).providers, [{id:'paystack',enabled:false},{id:'stripe',enabled:false}]);
    const raw = '{ "event": "fixture.ignored", "data": {} }';
    const signature = createHmac('sha512','sk_test_http_fixture').update(raw).digest('hex');
    const webhook = await fetch('http://localhost:4198/api/payments/webhooks/paystack', {method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':signature},body:raw});
    assert.equal(webhook.status,200, 'raw body must reach signature verifier before JSON parsing');
    const tampered = await fetch('http://localhost:4198/api/payments/webhooks/paystack', {method:'POST',headers:{'Content-Type':'application/json','x-paystack-signature':signature},body:raw+' '});
    assert.equal(tampered.status,400);
    const callRaw = '{ "ignored": true }';
    const callTimestamp = Math.floor(Date.now() / 1000);
    const callSignature = createHmac('sha256', 'voice-test-secret').update(`${callTimestamp}.${callRaw}`).digest('hex');
    const callHeaders = { 'Content-Type': 'application/json', 'x-aethex-event': 'fixture.ignored', 'x-aethex-signature': `t=${callTimestamp},v1=${callSignature}` };
    assert.equal((await fetch('http://localhost:4198/api/calls/webhook', {method:'POST',headers:callHeaders,body:callRaw})).status,200);
    assert.equal((await fetch('http://localhost:4198/api/calls/webhook', {method:'POST',headers:callHeaders,body:callRaw+' '})).status,401);

    assert.equal((await request('/api/payments/reservation/ABCDEFGHIJKL','POST',{provider:'paystack',choice:'full',email:'test@example.test',idempotencyKey:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',amount:1})).status,400);

    for (let i = 0; i < 120; i++) assert.equal((await request('/api/auth/me')).status, 401, 'normal polling must not exhaust the API limit');
    for (let i = 0; i < 30; i++) assert.equal((await request('/api/auth/otp/send', 'POST', {})).status, 400);
    assert.equal((await request('/api/auth/otp/send', 'POST', {})).status, 429, 'OTP requests retain a separate abuse limit');

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
