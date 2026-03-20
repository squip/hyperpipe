import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function parseEnvText(text) {
  const result = {};
  const input = typeof text === 'string' ? text : '';
  for (const rawLine of input.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = rawLine.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = rawLine.slice(separatorIndex + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export async function readEnvFile(path) {
  const text = await readFile(path, 'utf8');
  return parseEnvText(text);
}

function encodeValue(value) {
  const text = value == null ? '' : String(value);
  if (text === '') return '';
  if (/[\s#"'`]/u.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

export function serializeSectionedEnv(sections, values, { headerComment = null } = {}) {
  const lines = [];
  if (headerComment) {
    for (const line of String(headerComment).split('\n')) {
      lines.push(`# ${line}`.trimEnd());
    }
    lines.push('');
  }
  for (const section of sections) {
    if (section.comment) {
      lines.push(`# ${section.comment}`);
    }
    for (const key of section.keys) {
      if (!(key in values)) continue;
      lines.push(`${key}=${encodeValue(values[key])}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

export async function writeEnvFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
