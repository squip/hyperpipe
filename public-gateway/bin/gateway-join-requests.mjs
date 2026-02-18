#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const gatewayAdmin = resolve(binDir, 'gateway-admin.mjs');
const [, , action, requestId] = process.argv;
const args = ['operator', 'join-requests', action, requestId].filter(Boolean);
const result = spawnSync(process.execPath, [gatewayAdmin, ...args], { stdio: 'inherit' });
process.exitCode = result.status || 0;
