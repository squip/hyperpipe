import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTokenCache, writeTokenCache } from '../bin/_gateway-client.mjs';

test('gateway CLI token cache read/write helpers', async () => {
  const path = join(tmpdir(), `gateway-cli-cache-${Date.now()}.json`);
  process.env.GATEWAY_CLI_TOKEN_CACHE = path;

  await writeTokenCache({
    tokens: {
      alpha: {
        token: 'token-1',
        expiresAt: Date.now() + 60_000
      }
    }
  });

  const loaded = await readTokenCache();
  assert.equal(typeof loaded, 'object');
  assert.equal(loaded.tokens.alpha.token, 'token-1');

  await rm(path, { force: true });
});
