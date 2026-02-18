#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const gatewayAdmin = resolve(binDir, 'gateway-admin.mjs');
const [, , action, pubkey] = process.argv;
const args = ['operator', 'invite', action, pubkey].filter(Boolean);
const result = spawnSync(process.execPath, [gatewayAdmin, ...args], { stdio: 'inherit' });
process.exitCode = result.status || 0;
