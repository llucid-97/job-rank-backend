// Audience: maintainers. Check the browser can read provider retry timing over CORS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { app } from '../src/app.js';

test('allowed browser origins can read Retry-After', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const res = await fetch(`http://127.0.0.1:${address.port}/health`, {headers:{Origin:'http://127.0.0.1:3001'}});
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3001');
    assert.equal(res.headers.get('access-control-expose-headers'), 'Retry-After');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
