#!/usr/bin/env node
import { readCliGatewayConfig, gatewayRequest } from './_gateway-client.mjs';

async function main() {
  const [, , action, requestId] = process.argv;
  if (!action || !['list', 'approve', 'reject'].includes(action)) {
    throw new Error('Usage: gateway-join-requests <list|approve|reject> [requestId]');
  }
  const cfg = readCliGatewayConfig();
  if (action === 'list') {
    const result = await gatewayRequest({
      ...cfg,
      path: '/api/gateway/join-requests',
      method: 'GET'
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!requestId) {
    throw new Error('requestId is required');
  }
  const result = await gatewayRequest({
    ...cfg,
    path: `/api/gateway/join-requests/${encodeURIComponent(requestId)}/${action}`,
    method: 'POST'
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
