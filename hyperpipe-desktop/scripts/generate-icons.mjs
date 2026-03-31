import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import pngToIco from 'png-to-ico'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const APP_ROOT = path.resolve(__dirname, '..')
const BUILD_ROOT = path.join(APP_ROOT, 'build')
const PUBLIC_ROOT = path.join(APP_ROOT, 'public')
const SRC_ASSETS_ROOT = path.join(APP_ROOT, 'src', 'assets')
const BUILD_ICONS_ROOT = path.join(BUILD_ROOT, 'icons')

const PIPE = {
  hilite: '#d8b0ff',
  light: '#b070e0',
  mid: '#8040c0',
  dark: '#582098',
  outline: '#101010'
}

function shadePipeRow(width) {
  const cells = []
  const inner = width - 2
  const hiliteEnd = Math.max(1, Math.round(inner * 0.12))
  const lightEnd = Math.max(hiliteEnd + 1, Math.round(inner * 0.25))
  const ditherStart = Math.round(inner * 0.68)
  const darkStart = Math.max(ditherStart + 1, Math.round(inner * 0.88))

  for (let index = 0; index < inner; index += 1) {
    if (index < hiliteEnd) {
      cells.push({ ch: '█', color: PIPE.hilite })
    } else if (index < lightEnd) {
      cells.push({ ch: '█', color: PIPE.light })
    } else if (index < ditherStart) {
      cells.push({ ch: '█', color: PIPE.mid })
    } else if (index < darkStart) {
      cells.push({ ch: '▓', color: index % 2 === 0 ? PIPE.mid : PIPE.dark })
    } else {
      cells.push({ ch: '█', color: PIPE.dark })
    }
  }

  return cells
}

function buildMarioPipe(lipW, bodyW, bodyRows) {
  const overhang = Math.floor((lipW - bodyW) / 2)
  const rows = []

  rows.push(Array.from({ length: lipW }, () => ({ ch: '█', color: PIPE.outline })))

  for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
    rows.push([
      { ch: '█', color: PIPE.outline },
      ...shadePipeRow(lipW),
      { ch: '█', color: PIPE.outline }
    ])
  }

  rows.push(Array.from({ length: lipW }, () => ({ ch: '█', color: PIPE.outline })))

  for (let bodyIndex = 0; bodyIndex < bodyRows; bodyIndex += 1) {
    rows.push([
      ...Array.from({ length: overhang }, () => ({ ch: ' ', color: null })),
      { ch: '█', color: PIPE.outline },
      ...shadePipeRow(bodyW),
      { ch: '█', color: PIPE.outline },
      ...Array.from({ length: overhang }, () => ({ ch: ' ', color: null }))
    ])
  }

  return {
    rows,
    width: lipW,
    height: rows.length
  }
}

function renderPipeSvg({ monochrome = false, background = false }) {
  const pipe = buildMarioPipe(18, 14, 13)
  const viewBox = 1024
  const cellSize = 40
  const pipeWidth = pipe.width * cellSize
  const pipeHeight = pipe.height * cellSize
  const offsetX = Math.round((viewBox - pipeWidth) / 2)
  const offsetY = Math.round((viewBox - pipeHeight) / 2)
  const fillColor = monochrome ? '#111111' : null

  const rects = []
  for (let row = 0; row < pipe.rows.length; row += 1) {
    for (let col = 0; col < pipe.rows[row].length; col += 1) {
      const cell = pipe.rows[row][col]
      if (cell.ch === ' ' || !cell.color) continue

      const x = offsetX + col * cellSize
      const y = offsetY + row * cellSize
      const fill = fillColor || cell.color
      const opacity = monochrome ? 1 : cell.ch === '▓' ? 0.9 : 1
      rects.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fill}" opacity="${opacity}" />`
      )
    }
  }

  const defs = background
    ? `<defs>
  <linearGradient id="bg" x1="512" y1="44" x2="512" y2="980" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="#050505" />
    <stop offset="100%" stop-color="#111111" />
  </linearGradient>
</defs>`
    : ''

  const backgroundMarkup = background
    ? `<rect x="44" y="44" width="936" height="936" rx="208" fill="url(#bg)" />`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" shape-rendering="crispEdges">
${defs}
${backgroundMarkup}
${rects.join('\n')}
</svg>
`
}

async function writeFile(targetPath, contents) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, contents, 'utf8')
}

function rasterizeSvg(inputPath, size, outputPath) {
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), inputPath, '--out', outputPath], {
    stdio: 'ignore'
  })
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function main() {
  await ensureDir(BUILD_ROOT)
  await ensureDir(PUBLIC_ROOT)
  await ensureDir(SRC_ASSETS_ROOT)
  await ensureDir(BUILD_ICONS_ROOT)

  const fullColorSvg = renderPipeSvg({ background: true })
  const monochromeSvg = renderPipeSvg({ monochrome: true, background: false })

  const buildSourceSvgPath = path.join(BUILD_ROOT, 'icon-source.svg')
  const buildMonochromeSvgPath = path.join(BUILD_ROOT, 'icon-monochrome.svg')

  await Promise.all([
    writeFile(buildSourceSvgPath, fullColorSvg),
    writeFile(path.join(PUBLIC_ROOT, 'favicon.svg'), fullColorSvg),
    writeFile(buildMonochromeSvgPath, monochromeSvg),
    writeFile(path.join(PUBLIC_ROOT, 'pwa-monochrome.svg'), monochromeSvg),
    writeFile(path.join(SRC_ASSETS_ROOT, 'favicon.svg'), monochromeSvg)
  ])

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyperpipe-iconset-'))
  const tmpIconset = path.join(tmpRoot, 'icon.iconset')
  await fs.mkdir(tmpIconset, { recursive: true })

  const pngSizes = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]
  const renderedPngs = new Map()
  for (const size of pngSizes) {
    const outputPath = path.join(tmpRoot, `${size}.png`)
    rasterizeSvg(buildSourceSvgPath, size, outputPath)
    renderedPngs.set(size, outputPath)
  }

  const iconsetTargets = new Map([
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ])

  for (const [fileName, size] of iconsetTargets) {
    await fs.copyFile(renderedPngs.get(size), path.join(tmpIconset, fileName))
  }

  execFileSync('iconutil', ['-c', 'icns', tmpIconset, '-o', path.join(BUILD_ROOT, 'icon.icns')], {
    stdio: 'ignore'
  })

  const icoBuffer = await pngToIco(
    [16, 32, 48, 64, 128, 256].map((size) => renderedPngs.get(size))
  )
  await fs.writeFile(path.join(BUILD_ROOT, 'icon.ico'), icoBuffer)
  await fs.writeFile(path.join(PUBLIC_ROOT, 'favicon.ico'), icoBuffer)

  await Promise.all([
    fs.copyFile(renderedPngs.get(512), path.join(BUILD_ROOT, 'icon.png')),
    fs.copyFile(renderedPngs.get(192), path.join(PUBLIC_ROOT, 'pwa-192x192.png')),
    fs.copyFile(renderedPngs.get(512), path.join(PUBLIC_ROOT, 'pwa-512x512.png')),
    fs.copyFile(renderedPngs.get(180), path.join(PUBLIC_ROOT, 'apple-touch-icon.png'))
  ])

  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await fs.copyFile(renderedPngs.get(size), path.join(BUILD_ICONS_ROOT, `${size}x${size}.png`))
  }

  await fs.rm(tmpRoot, { recursive: true, force: true })

  console.log('Generated Hyperpipe icon assets:')
  console.log(`- ${path.join(BUILD_ROOT, 'icon.icns')}`)
  console.log(`- ${path.join(BUILD_ROOT, 'icon.ico')}`)
  console.log(`- ${path.join(PUBLIC_ROOT, 'favicon.ico')}`)
  console.log(`- ${path.join(PUBLIC_ROOT, 'pwa-192x192.png')}`)
  console.log(`- ${path.join(PUBLIC_ROOT, 'pwa-512x512.png')}`)
}

main().catch(async (error) => {
  console.error('[generate-icons] Failed to generate icon assets')
  console.error(error)
  process.exitCode = 1
})
