#!/usr/bin/env node
import { readCliGatewayConfig, gatewayRequest } from './_gateway-client.mjs';

async function main() {
  const [, , action, pubkey] = process.argv;
  if (!action || !['add', 'remove', 'list'].includes(action)) {
    throw new Error('Usage: gateway-allow <add|remove|list> [pubkey]');
  }

  const cfg = readCliGatewayConfig();
  if (action === 'list') {
    const result = await gatewayRequest({
      ...cfg,
      path: '/api/gateway/policy',
      method: 'GET'
    });
    console.log(JSON.stringify({
      allowList: result?.allowList || [],
      count: Array.isArray(result?.allowList) ? result.allowList.length : 0
    }, null, 2));
    return;
  }

  if (!/^[a-f0-9]{64}$/i.test(pubkey || '')) {
    throw new Error('pubkey must be a 64-char hex value');
  }

  if (action === 'add') {
    const result = await gatewayRequest({
      ...cfg,
      path: '/api/gateway/allow-list',
      method: 'POST',
      body: { pubkey: pubkey.toLowerCase() }
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await gatewayRequest({
    ...cfg,
    path: `/api/gateway/allow-list/${encodeURIComponent(pubkey.toLowerCase())}`,
    method: 'DELETE'
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
