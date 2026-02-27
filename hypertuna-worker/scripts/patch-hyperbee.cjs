#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '..', 'node_modules', 'hyperbee', 'index.js')
const before = 'if (this._watchers && this.core.replicator.setInflightRange) {'
const after = 'if (this._watchers && this.core.replicator && this.core.replicator.setInflightRange) {'

if (!fs.existsSync(target)) {
  console.warn('[patch-hyperbee] hyperbee not installed yet, skipping')
  process.exit(0)
}

const source = fs.readFileSync(target, 'utf8')
if (source.includes(after)) {
  console.log('[patch-hyperbee] already patched')
  process.exit(0)
}

if (!source.includes(before)) {
  console.warn('[patch-hyperbee] expected pattern not found, skipping')
  process.exit(0)
}

const updated = source.replace(before, after)
fs.writeFileSync(target, updated, 'utf8')
console.log('[patch-hyperbee] patched hyperbee watcher inflight guard')
