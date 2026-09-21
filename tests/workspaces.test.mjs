import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

test('onboarding, tenant isolation, public privacy and booking conflicts', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: '4197', DOTENV_CONFIG_PATH: '/dev/null', ENABLE_CALL_SCHEDULER: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
      child.stdout.on('data', d => { if (String(d).includes('Reserv Backend running')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`API exited ${code}`)); });
    });
    async function request(path, { token, workspace, method = 'GET', body, status = 200 } = {}) {
      const res = await fetch(`http://localhost:4197/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(workspace ? { 'x-workspace-id': workspace } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json();
      assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    async function account(email) {
      const otp = await request('/auth/otp/send', { method: 'POST', body: { email } });
      const session = await request('/auth/otp/verify', { method: 'POST', body: { email, code: otp.devCode } });
      await request('/auth/otp/verify', { method: 'POST', body: { email, code: otp.devCode }, status: 401 });
      return session.token;
    }
    const a = await account('owner-a@example.test'), b = await account('owner-b@example.test');
    assert.deepEqual((await request('/workspaces', { token: a })).workspaces, []);
    const details = { name: 'Test studio', slug: 'studio-alpha', owner: 'Owner Alpha', category: 'Beauty', phone: '+2348000000000', address: 'Test address Abuja', serviceName: 'Consultation', duration: 45, price: 5000, avatarUrl: 'https://example.test/profile.webp', logoUrl: 'https://example.test/logo.webp', icon: 'flower' };
    const alpha = await request('/workspaces', { token: a, method: 'POST', body: details, status: 201 });
    const beta = await request('/workspaces', { token: b, method: 'POST', body: { ...details, slug: 'studio-beta' }, status: 201 });
    assert.equal(alpha.state.staff[0].avatarUrl, details.avatarUrl);
    assert.equal(alpha.state.settings.ownerStaffId, alpha.state.staff[0].id);
    assert.equal(alpha.state.business.logoUrl, details.logoUrl);
    assert.equal(alpha.state.business.icon, 'flower');
    await request('/workspaces', { token: a, method: 'POST', body: { ...details, avatarUrl: 'javascript:alert(1)' }, status: 400 });
    await request('/upload/image', { method: 'POST', status: 401 });
    const invalidImage = new FormData(); invalidImage.append('file', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
    const invalidImageResult = await fetch('http://localhost:4197/api/upload/image', { method: 'POST', headers: { Authorization: `Bearer ${a}` }, body: invalidImage });
    assert.equal(invalidImageResult.status, 400);
    const aid = alpha.state.business.id, bid = beta.state.business.id;
    await request(`/workspaces/${bid}/state`, { token: a, status: 404 });
    await request(`/workspaces/${bid}/state`, { token: a, method: 'PUT', body: beta, status: 404 });
    await request('/bookings', { token: a, workspace: bid, status: 404 });
    assert.equal((await request('/workspaces', { token: a })).workspaces.length, 1);
    const changed = structuredClone(alpha);
    changed.state.business.description = 'Alpha only';
    changed.state.staff[0].avatarUrl = 'https://example.test/updated.webp';
    const saved = await request(`/workspaces/${aid}/state`, { token: a, method: 'PUT', body: changed });
    await request(`/workspaces/${aid}/state`, { token: a, method: 'PUT', body: changed, status: 409 });
    assert.equal((await request(`/workspaces/${bid}/state`, { token: b })).state.business.description, '');
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 3);
    while ([0,6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    const payload = { serviceId: saved.state.services[0].id, staffId: saved.state.staff[0].id, startTime: `${date.toISOString().slice(0,10)}T10:00:00`, name: 'Private Customer', phone: '+2348111111111', notes: 'Private booking note' };
    const created = await request('/public/businesses/studio-alpha/bookings', { method: 'POST', body: payload, status: 201 });
    assert.match(created.booking.code, /^[A-Z0-9]{12}$/);
    await request('/public/businesses/studio-alpha/bookings', { method: 'POST', body: payload, status: 409 });
    const profile = await request('/public/businesses/studio-alpha');
    assert.equal(profile.state.staff[0].avatarUrl, 'https://example.test/updated.webp');
    assert.equal(profile.state.business.logoUrl, details.logoUrl);
    assert.deepEqual(profile.state.customers, []);
    assert.deepEqual(profile.state.bookings, []);
    assert.equal(JSON.stringify(profile).includes('Private Customer'), false);
    assert.equal((await request(`/public/reservations/${created.booking.code}`)).state.bookings.length, 1);
    assert.equal((await request(`/workspaces/${bid}/state`, { token: b })).state.bookings.length, 0);
    await request(`/public/reservations/${created.booking.code}`, { method: 'PATCH', body: { action: 'cancel' } });
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
});
