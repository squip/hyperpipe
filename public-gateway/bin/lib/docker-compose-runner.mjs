import { spawn } from 'node:child_process';

function runProcess(command, args = [], {
  cwd = process.cwd(),
  capture = false,
  stdio = 'inherit'
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : stdio,
      env: process.env
    });

    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const error = new Error(`Command failed (${command} ${args.join(' ')})`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function detectComposeCommand() {
  try {
    await runProcess('docker', ['compose', 'version'], { capture: true });
    return { command: 'docker', argsPrefix: ['compose'] };
  } catch (_) {}

  try {
    await runProcess('docker-compose', ['version'], { capture: true });
    return { command: 'docker-compose', argsPrefix: [] };
  } catch (_) {}

  throw new Error('Neither `docker compose` nor `docker-compose` is available');
}

async function runCompose({ runtimeDir, composeFile, envFile, args = [], capture = false }) {
  const compose = await detectComposeCommand();
  const fullArgs = [
    ...compose.argsPrefix,
    '-f',
    composeFile,
    '--env-file',
    envFile,
    ...args
  ];
  return await runProcess(compose.command, fullArgs, {
    cwd: runtimeDir,
    capture,
    stdio: capture ? undefined : 'inherit'
  });
}

async function waitForGatewayHealth(url, { timeoutMs = 120000, intervalMs = 2500 } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const response = await fetch(new URL('/health', url));
      if (response.ok) {
        return {
          ok: true,
          elapsedMs: Date.now() - startedAt
        };
      }
      lastError = new Error(`Gateway health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    elapsedMs: Date.now() - startedAt,
    error: lastError?.message || 'health-timeout'
  };
}

export {
  detectComposeCommand,
  runCompose,
  waitForGatewayHealth
};
