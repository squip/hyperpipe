#!/usr/bin/env node
import { readCliGatewayConfig, gatewayRequest } from './_gateway-client.mjs';

async function main() {
  const [, , action, pubkey] = process.argv;
  if (action !== 'create') {
    throw new Error('Usage: gateway-invite create <pubkey>');
  }
  if (!/^[a-f0-9]{64}$/i.test(pubkey || '')) {
    throw new Error('pubkey must be a 64-char hex value');
  }
  const cfg = readCliGatewayConfig();
  const result = await gatewayRequest({
    ...cfg,
    path: '/api/gateway/invites',
    method: 'POST',
    body: { pubkey: pubkey.toLowerCase() }
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
