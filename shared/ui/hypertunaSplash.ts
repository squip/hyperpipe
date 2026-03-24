export type HypertunaSplashPhase = 'emit' | 'swarm' | 'settle' | 'hold'

export type HypertunaSplashRenderCell = {
  char: string
  color: string
}

export type HyperpipeWordmarkCell = {
  col: number
  row: number
  color: string
}

export type HyperpipeWordmarkLayout = {
  width: number
  height: number
  cells: HyperpipeWordmarkCell[]
}

type PipeCell = {
  ch: string
  color: string | null
}

type PipeData = {
  rows: PipeCell[][]
  width: number
}

type Particle = {
  tx: number
  ty: number
  x: number
  y: number
  vx: number
  vy: number
  color: string
  delay: number
  born: boolean
  birthFrame: number
  swarmPhase: number
  settled: boolean
}

type SmokeParticle = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  decay: number
}

export type HypertunaSplashState = {
  cols: number
  rows: number
  particles: Particle[]
  smokeParticles: SmokeParticle[]
  pipeData: PipeData
  pipeStartCol: number
  pipeStartRow: number
  frame: number
  phase: HypertunaSplashPhase
  subtitleRow: number
  holdStartFrame: number | null
}

type Layout = {
  cols: number
  rows: number
  letterGap: number
  lipW: number
  bodyW: number
  pipeStartRow: number
  pipeBodyRows: number
  textRow: number
  subtitleRow: number
  pipeStartCol: number
  spawnCol: number
  spawnRow: number
}

const FONT = {
  H: ['#...#', '#...#', '#####', '#...#', '#...#'],
  Y: ['#...#', '.#.#.', '..#..', '..#..', '..#..'],
  P: ['####.', '#...#', '####.', '#....', '#....'],
  E: ['#####', '#....', '####.', '#....', '#####'],
  R: ['####.', '#...#', '####.', '#.#..', '#..##'],
  I: ['###', '.#.', '.#.', '.#.', '###']
} as const

type FontKey = keyof typeof FONT

const WORD: FontKey[] = ['H', 'Y', 'P', 'E', 'R', 'P', 'I', 'P', 'E']
const SUBTITLE = 'peer-to-peer nostr relays'

const PARTICLE_COLORS = [
  '#4ade80',
  '#22d3ee',
  '#16a34a',
  '#0891b2',
  '#ffffff',
  '#7ee787',
  '#56d4dd'
]

const PIPE = {
  hilite: '#d8b0ff',
  light: '#b070e0',
  mid: '#8040c0',
  dark: '#582098',
  deep: '#381068',
  outline: '#101010',
  subtitle: '#a3a3a3'
} as const

const PHASE_TIMES = {
  emit: 55,
  swarm: 120,
  settle: 200
} as const

const HOLD_FRAMES = 81

export const HYPERTUNA_SPLASH_FRAME_INTERVAL_MS = 45
export const HYPERTUNA_SPLASH_TOTAL_FRAMES = PHASE_TIMES.settle + HOLD_FRAMES
export const HYPERTUNA_SPLASH_TUI_DURATION_MS =
  HYPERTUNA_SPLASH_TOTAL_FRAMES * HYPERTUNA_SPLASH_FRAME_INTERVAL_MS + 220
export const HYPERTUNA_SPLASH_DESKTOP_DURATION_MS = 5600
export const HYPERPIPE_WORDMARK_LETTER_GAP = 2

function shadePipeRow(width: number): PipeCell[] {
  const cells: PipeCell[] = []
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

function buildMarioPipe(lipW: number, bodyW: number, bodyRows: number): PipeData {
  const overhang = Math.floor((lipW - bodyW) / 2)
  const rows: PipeCell[][] = []

  {
    const row: PipeCell[] = []
    for (let index = 0; index < lipW; index += 1) {
      row.push({ ch: '█', color: PIPE.outline })
    }
    rows.push(row)
  }

  for (let rowIndex = 0; rowIndex < 2; rowIndex += 1) {
    const row: PipeCell[] = []
    row.push({ ch: '█', color: PIPE.outline })
    row.push(...shadePipeRow(lipW))
    row.push({ ch: '█', color: PIPE.outline })
    rows.push(row)
  }

  {
    const row: PipeCell[] = []
    for (let index = 0; index < lipW; index += 1) {
      row.push({ ch: '█', color: PIPE.outline })
    }
    rows.push(row)
  }

  for (let bodyIndex = 0; bodyIndex < bodyRows; bodyIndex += 1) {
    const row: PipeCell[] = []

    for (let index = 0; index < overhang; index += 1) {
      row.push({ ch: ' ', color: null })
    }

    row.push({ ch: '█', color: PIPE.outline })
    row.push(...shadePipeRow(bodyW))
    row.push({ ch: '█', color: PIPE.outline })

    for (let index = 0; index < overhang; index += 1) {
      row.push({ ch: ' ', color: null })
    }

    rows.push(row)
  }

  return {
    rows,
    width: lipW
  }
}

function getTextTargets(
  cols: number,
  textRow: number,
  letterGap: number
): Array<{ col: number; row: number }> {
  let totalWidth = 0
  for (const ch of WORD) {
    totalWidth += FONT[ch][0].length
  }
  totalWidth += (WORD.length - 1) * letterGap

  const startCol = Math.floor((cols - totalWidth) / 2)
  const targets: Array<{ col: number; row: number }> = []
  let currentCol = startCol

  for (const ch of WORD) {
    const glyph = FONT[ch]
    const width = glyph[0].length
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (glyph[row][col] === '#') {
          targets.push({ col: currentCol + col, row: textRow + row })
        }
      }
    }
    currentCol += width + letterGap
  }

  return targets
}

function getWordmarkColor(col: number, row: number, index: number): string {
  const hash = (col * 73856093) ^ (row * 19349663) ^ (index * 83492791)
  return PARTICLE_COLORS[Math.abs(hash) % PARTICLE_COLORS.length]
}

export function getHyperpipeWordmarkLayout(
  letterGap = HYPERPIPE_WORDMARK_LETTER_GAP
): HyperpipeWordmarkLayout {
  const cells: HyperpipeWordmarkCell[] = []
  let currentCol = 0

  for (const ch of WORD) {
    const glyph = FONT[ch]
    const glyphWidth = glyph[0].length

    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyphWidth; col += 1) {
        if (glyph[row][col] !== '#') continue

        cells.push({
          col: currentCol + col,
          row,
          color: getWordmarkColor(currentCol + col, row, cells.length)
        })
      }
    }

    currentCol += glyphWidth + letterGap
  }

  return {
    width: Math.max(0, currentCol - letterGap),
    height: Math.max(...WORD.map((ch) => FONT[ch].length)),
    cells
  }
}

function createParticle(
  targetCol: number,
  targetRow: number,
  spawnCol: number,
  spawnRow: number,
  index: number,
  total: number
): Particle {
  return {
    tx: targetCol,
    ty: targetRow,
    x: spawnCol + (Math.random() - 0.5) * 5,
    y: spawnRow,
    vx: (Math.random() - 0.5) * 3,
    vy: -(Math.random() * 2 + 1.2),
    color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
    delay: Math.floor((index / total) * 50) + Math.floor(Math.random() * 10),
    born: false,
    birthFrame: 0,
    swarmPhase: Math.random() * Math.PI * 2,
    settled: false
  }
}

function updateParticle(particle: Particle, frame: number, phase: HypertunaSplashPhase): void {
  if (frame < particle.delay) return

  if (!particle.born) {
    particle.born = true
    particle.birthFrame = frame
  }

  const age = frame - particle.birthFrame

  if (phase === 'emit') {
    particle.x += particle.vx
    particle.y += particle.vy
    particle.vy *= 0.97
    particle.vx *= 0.96
    particle.vy -= 0.02
  }

  if (phase === 'swarm') {
    const tick = age * 0.06
    particle.vx += Math.sin(particle.swarmPhase + tick) * 0.3
    particle.vy += Math.cos(particle.swarmPhase + tick * 1.2) * 0.22

    const deltaX = particle.tx - particle.x
    const deltaY = particle.ty - particle.y

    particle.vx += deltaX * 0.004
    particle.vy += deltaY * 0.004
    particle.vx *= 0.93
    particle.vy *= 0.93
    particle.x += particle.vx
    particle.y += particle.vy
  }

  if (phase === 'settle') {
    const deltaX = particle.tx - particle.x
    const deltaY = particle.ty - particle.y

    particle.x += deltaX * 0.12
    particle.y += deltaY * 0.12
    particle.vx *= 0.82
    particle.vy *= 0.82

    if (Math.abs(deltaX) < 0.3 && Math.abs(deltaY) < 0.3) {
      particle.x = particle.tx
      particle.y = particle.ty
      particle.settled = true
    }
  }

  if (phase === 'hold') {
    particle.x = particle.tx + Math.sin(frame * 0.04 + particle.swarmPhase) * 0.35
    particle.y = particle.ty + Math.cos(frame * 0.05 + particle.swarmPhase) * 0.2
    particle.settled = true
  }
}

function createSmoke(spawnCol: number, spawnRow: number): SmokeParticle {
  return {
    x: spawnCol + (Math.random() - 0.5) * 3,
    y: spawnRow - Math.random() * 0.3,
    vx: (Math.random() - 0.5) * 0.25,
    vy: -(Math.random() * 0.5 + 0.15),
    life: 1,
    decay: Math.random() * 0.04 + 0.02
  }
}

function updateSmoke(smoke: SmokeParticle): void {
  smoke.x += smoke.vx
  smoke.y += smoke.vy
  smoke.life -= smoke.decay
}

function computeLayout(termCols: number, termRows: number): Layout {
  const cols = Math.max(24, termCols - 1)
  const rows = Math.max(14, termRows - 1)

  const letterGap = cols < 60 ? 1 : 2

  let lipW = Math.floor(cols * 0.28)
  lipW = Math.max(12, Math.min(30, lipW))
  if (lipW % 2 !== 0) lipW -= 1

  let bodyW = lipW - 4
  if (bodyW < 6) bodyW = 6
  if (bodyW % 2 !== 0) bodyW -= 1

  const pipeStartRow = Math.max(8, Math.floor(rows * 0.62))
  const pipeBodyRows = Math.max(1, rows - pipeStartRow)
  const textRow = Math.max(1, Math.floor(pipeStartRow * 0.45))
  const subtitleRow = textRow + 6

  const pipeStartCol = Math.floor((cols - lipW) / 2)
  const spawnCol = Math.floor(cols / 2)
  const spawnRow = pipeStartRow - 1

  return {
    cols,
    rows,
    letterGap,
    lipW,
    bodyW,
    pipeStartRow,
    pipeBodyRows,
    textRow,
    subtitleRow,
    pipeStartCol,
    spawnCol,
    spawnRow
  }
}

export function getHypertunaSplashPhase(frame: number): HypertunaSplashPhase {
  if (frame < PHASE_TIMES.emit) return 'emit'
  if (frame < PHASE_TIMES.swarm) return 'swarm'
  if (frame < PHASE_TIMES.settle) return 'settle'
  return 'hold'
}

export function createHypertunaSplashState(termCols: number, termRows: number): HypertunaSplashState {
  const layout = computeLayout(termCols, termRows)
  const targets = getTextTargets(layout.cols, layout.textRow, layout.letterGap)
  const particles = targets.map((target, index) =>
    createParticle(target.col, target.row, layout.spawnCol, layout.spawnRow, index, targets.length)
  )
  const smokeParticles = Array.from({ length: 12 }, () => createSmoke(layout.spawnCol, layout.spawnRow))

  return {
    cols: layout.cols,
    rows: layout.rows,
    particles,
    smokeParticles,
    pipeData: buildMarioPipe(layout.lipW, layout.bodyW, layout.pipeBodyRows),
    pipeStartCol: layout.pipeStartCol,
    pipeStartRow: layout.pipeStartRow,
    frame: 0,
    phase: 'emit',
    subtitleRow: layout.subtitleRow,
    holdStartFrame: null
  }
}

export function advanceHypertunaSplashState(
  state: HypertunaSplashState,
  targetFrame: number
): HypertunaSplashState {
  const boundedTarget = Math.max(0, Math.min(HYPERTUNA_SPLASH_TOTAL_FRAMES, Math.floor(targetFrame)))
  while (state.frame < boundedTarget) {
    state.frame += 1
    state.phase = getHypertunaSplashPhase(state.frame)

    if (state.phase === 'hold' && state.holdStartFrame === null) {
      state.holdStartFrame = state.frame
    }

    for (const particle of state.particles) {
      updateParticle(particle, state.frame, state.phase)
    }

    for (const smoke of state.smokeParticles) {
      updateSmoke(smoke)
      if (smoke.life <= 0) {
        const spawnCol = Math.floor(state.cols / 2)
        const spawnRow = state.pipeStartRow - 1
        Object.assign(smoke, createSmoke(spawnCol, spawnRow))
      }
    }
  }

  return state
}

export function getHypertunaSplashTargetFrame(
  elapsedMs: number,
  playbackDurationMs: number
): number {
  if (playbackDurationMs <= 0) return HYPERTUNA_SPLASH_TOTAL_FRAMES
  const progress = Math.min(1, Math.max(0, elapsedMs / playbackDurationMs))
  return Math.floor(progress * HYPERTUNA_SPLASH_TOTAL_FRAMES)
}

export function renderHypertunaSplashGrid(
  state: HypertunaSplashState
): Array<Array<HypertunaSplashRenderCell | null>> {
  const {
    cols,
    rows,
    particles,
    smokeParticles,
    pipeData,
    pipeStartCol,
    pipeStartRow,
    frame,
    phase,
    subtitleRow
  } = state

  const grid: Array<Array<HypertunaSplashRenderCell | null>> = []
  for (let row = 0; row < rows; row += 1) {
    grid[row] = new Array(cols).fill(null)
  }

  for (let pipeRowIndex = 0; pipeRowIndex < pipeData.rows.length; pipeRowIndex += 1) {
    const row = pipeStartRow + pipeRowIndex
    if (row < 0 || row >= rows) continue

    const pipeRow = pipeData.rows[pipeRowIndex]
    for (let col = 0; col < pipeRow.length; col += 1) {
      const outputCol = pipeStartCol + col
      if (outputCol < 0 || outputCol >= cols) continue

      const cell = pipeRow[col]
      if (cell.ch !== ' ' && cell.color) {
        grid[row][outputCol] = { char: cell.ch, color: cell.color }
      }
    }
  }

  if (phase === 'emit' || phase === 'swarm') {
    const glowRow = pipeStartRow - 1
    const centerCol = pipeStartCol + Math.floor(pipeData.width / 2)

    if (glowRow >= 0 && glowRow < rows) {
      const pulse = Math.sin(frame * 0.15) > 0
      const glowChars = pulse ? '░░░░░' : ' ░░░ '

      for (let index = 0; index < glowChars.length; index += 1) {
        const col = centerCol - 2 + index
        if (col >= 0 && col < cols && glowChars[index] !== ' ') {
          grid[glowRow][col] = { char: glowChars[index], color: PIPE.deep }
        }
      }
    }
  }

  if (phase === 'emit' || phase === 'swarm') {
    for (const smoke of smokeParticles) {
      if (smoke.life <= 0) continue

      const col = Math.round(smoke.x)
      const row = Math.round(smoke.y)
      if (row >= 0 && row < rows && col >= 0 && col < cols && !grid[row][col]) {
        const char = smoke.life > 0.6 ? '░' : '·'
        const color = smoke.life > 0.5 ? PIPE.dark : PIPE.deep
        grid[row][col] = { char, color }
      }
    }
  }

  for (const particle of particles) {
    if (!particle.born) continue

    const col = Math.round(particle.x)
    const row = Math.round(particle.y)
    if (row >= 0 && row < rows && col >= 0 && col < cols) {
      grid[row][col] = {
        char: '█',
        color: particle.color
      }
    }
  }

  if (phase === 'hold') {
    const holdStart = state.holdStartFrame ?? frame
    const elapsed = frame - holdStart
    const revealCount = Math.min(SUBTITLE.length, Math.floor(elapsed / 1.2))
    const subtitleStartCol = Math.floor((cols - SUBTITLE.length) / 2)
    const middle = Math.floor(SUBTITLE.length / 2)

    if (subtitleRow >= 0 && subtitleRow < rows) {
      for (let index = 0; index < SUBTITLE.length; index += 1) {
        const distanceFromMiddle = Math.abs(index - middle)
        const revealed = distanceFromMiddle <= revealCount / 2
        const col = subtitleStartCol + index

        if (col >= 0 && col < cols && revealed) {
          grid[subtitleRow][col] = {
            char: SUBTITLE[index],
            color: PIPE.subtitle
          }
        }
      }

      if (elapsed > SUBTITLE.length * 0.6 && subtitleRow + 1 < rows) {
        const lineWidth = Math.min(Math.floor(elapsed * 0.5), SUBTITLE.length + 4)
        const lineStart = Math.floor(cols / 2) - Math.floor(lineWidth / 2)

        for (let index = 0; index < lineWidth; index += 1) {
          const col = lineStart + index
          if (col >= 0 && col < cols) {
            grid[subtitleRow + 1][col] = {
              char: '─',
              color: PIPE.deep
            }
          }
        }
      }
    }
  }

  return grid
}
