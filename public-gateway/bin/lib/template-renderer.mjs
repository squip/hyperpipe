import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(MODULE_DIR, '..', '..', 'deploy', 'templates');

function templatePath(name) {
  return resolve(TEMPLATE_DIR, name);
}

async function loadTemplate(name) {
  return await readFile(templatePath(name), 'utf8');
}

function serializeEnv(env = {}) {
  const keys = Object.keys(env).sort();
  const lines = [];
  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === null) continue;
    lines.push(`${key}=${String(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeRenderedFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function renderComposeTemplate({ profile, outputPath }) {
  const templateName = profile === 'internet'
    ? 'docker-compose.internet.yml'
    : 'docker-compose.local.yml';
  const content = await loadTemplate(templateName);
  await writeRenderedFile(outputPath, content);
  return { templateName, outputPath };
}

async function renderEnvExample({ profile, outputPath }) {
  const templateName = profile === 'internet'
    ? 'env.internet.example'
    : 'env.local.example';
  const content = await loadTemplate(templateName);
  await writeRenderedFile(outputPath, content);
  return { templateName, outputPath };
}

export {
  TEMPLATE_DIR,
  loadTemplate,
  serializeEnv,
  writeRenderedFile,
  renderComposeTemplate,
  renderEnvExample
};
