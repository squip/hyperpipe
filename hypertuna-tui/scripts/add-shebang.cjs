#!/usr/bin/env node
const fs = require('node:fs')

const target = process.argv[2]
if (!target) {
  process.stderr.write('Usage: add-shebang <file>\n')
  process.exit(1)
}

const content = fs.readFileSync(target, 'utf8')
if (content.startsWith('#!/usr/bin/env node')) {
  process.exit(0)
}

fs.writeFileSync(target, `#!/usr/bin/env node\n${content}`)
