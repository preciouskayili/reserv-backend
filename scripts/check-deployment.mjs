// Read-only checks: never signs in, creates bookings, sends messages, or calls providers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

function origin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname), 'Use HTTPS, or HTTP on localhost');
  assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Supply an origin without credentials, path, query, or fragment');
  return url.origin;
}

try {
  const [backendArg, frontendArg] = process.argv.slice(2);
  assert.ok(backendArg, 'Usage: pnpm check:deployment https://BACKEND [https://FRONTEND]');
  const backend = origin(backendArg);
  const frontend = frontendArg ? origin(frontendArg) : null;
  async function get(path, expected) {
    const response = await fetch(`${backend}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, expected, `${path}: expected HTTP ${expected}, got ${response.status}`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/, `${path}: expected JSON`);
    return response.json();
  }
  const health = await get('/health', 200);
  assert.equal(health.status, 'ok');
  assert.equal(health.service, 'reserv-backend');
  console.log(`PASS: backend health; deployed release ${health.release || 'not reported'}`);
  if (process.env.EXPECTED_RELEASE) {
    assert.equal(health.release, process.env.EXPECTED_RELEASE, 'Deployed release does not match EXPECTED_RELEASE');
    console.log('PASS: deployed commit matches EXPECTED_RELEASE');
  }
  for (const path of ['/api/auth/me', '/api/workspaces', '/api/bookings', '/api/calls']) await get(path, 401);
  console.log('PASS: private routes reject unauthenticated requests');
  // A random absent slug checks the database read path without reading customer records.
  await get(`/api/public/businesses/reserv-check-${randomUUID()}`, 404);
  console.log('PASS: public business lookup reaches storage and returns an expected 404');
  const options = await get('/api/payments/options', 200);
  assert.ok(Array.isArray(options.providers));
  for (const id of ['paystack', 'stripe']) assert.equal(typeof options.providers.find(p => p.id === id)?.enabled, 'boolean');
  const enabled = options.providers.filter(p => p.enabled).map(p => p.id);
  console.log(`PASS: payment options; ${enabled.length ? enabled.join(', ') : 'transfer receipts only'}`);
  if (frontend) {
    const cors = await fetch(`${backend}/api/auth/otp/send`, {
      method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Origin: frontend, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(cors.status, 204, 'Frontend CORS preflight failed');
    assert.equal(cors.headers.get('access-control-allow-origin'), frontend, 'CLIENT_ORIGIN does not allow this frontend');
    const page = await fetch(`${frontend}/login`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(page.status, 200, 'Frontend login page is unavailable');
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    console.log('PASS: frontend login page and backend CORS');
  }
  console.log('Still required: real sign-in, booking, receipt upload/review, and controlled phone calls. These checks do not verify those flows.');
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : 'Deployment check failed'}`);
  process.exitCode = 1;
}
