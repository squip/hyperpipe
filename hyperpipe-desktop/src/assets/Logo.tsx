import { usePrimaryPage } from '@/PageManager'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/lib/utils'
import { getHyperpipeWordmarkLayout } from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'
import { useMemo } from 'react'

const CELL_HEIGHT = 18
const CELL_WIDTH = Math.round(CELL_HEIGHT * 0.62)
const PADDING_X = 8
const PADDING_Y = 8
const WORDMARK = getHyperpipeWordmarkLayout()
const VIEWBOX_WIDTH = WORDMARK.width * CELL_WIDTH + PADDING_X * 2
const VIEWBOX_HEIGHT = WORDMARK.height * CELL_HEIGHT + PADDING_Y * 2

type LogoVariant = 'sidebar' | 'hero'
type ResolvedLogoTheme = 'light' | 'dark' | 'pure-black'

const OUTLINE_OFFSETS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
] as const

const LOGO_PALETTES: Record<
  ResolvedLogoTheme,
  Record<LogoVariant, { outline: string; colors: string[] }>
> = {
  light: {
    sidebar: {
      outline: '#020617',
      colors: ['#0f172a', '#1e3a8a', '#1d4ed8', '#0284c7']
    },
    hero: {
      outline: '#020617',
      colors: ['#0f172a', '#1e40af', '#2563eb', '#0f4c81']
    }
  },
  dark: {
    sidebar: {
      outline: '#020617',
      colors: ['#60a5fa', '#38bdf8', '#2563eb', '#7dd3fc']
    },
    hero: {
      outline: '#020617',
      colors: ['#bfdbfe', '#60a5fa', '#38bdf8', '#1d4ed8']
    }
  },
  'pure-black': {
    sidebar: {
      outline: '#020617',
      colors: ['#93c5fd', '#38bdf8', '#2563eb', '#bae6fd']
    },
    hero: {
      outline: '#020617',
      colors: ['#dbeafe', '#7dd3fc', '#60a5fa', '#2563eb']
    }
  }
}

function getPaletteColor(colors: string[], col: number, row: number, index: number) {
  const hash = (col * 73856093) ^ (row * 19349663) ^ (index * 83492791)
  return colors[Math.abs(hash) % colors.length]
}

function buildOutlineCells(cells: typeof WORDMARK.cells) {
  const occupied = new Set(cells.map((cell) => `${cell.col}:${cell.row}`))
  const outline = new Set<string>()

  cells.forEach((cell) => {
    OUTLINE_OFFSETS.forEach(([dx, dy]) => {
      const key = `${cell.col + dx}:${cell.row + dy}`
      if (!occupied.has(key)) {
        outline.add(key)
      }
    })
  })

  return [...outline].map((key) => {
    const [col, row] = key.split(':').map(Number)
    return { col, row }
  })
}

export default function Logo({
  className,
  variant = 'sidebar'
}: {
  className?: string
  variant?: LogoVariant
}) {
  const { navigate } = usePrimaryPage()
  const { resolvedTheme } = useTheme()
  const palette =
    LOGO_PALETTES[(resolvedTheme || 'light') as ResolvedLogoTheme]?.[variant] ??
    LOGO_PALETTES.light.sidebar
  const outlineCells = useMemo(() => buildOutlineCells(WORDMARK.cells), [])
  const coloredCells = useMemo(
    () =>
      WORDMARK.cells.map((cell, index) => ({
        ...cell,
        fill: getPaletteColor(palette.colors, cell.col, cell.row, index)
      })),
    [palette.colors]
  )

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMinYMid meet"
      shapeRendering="crispEdges"
      className={cn('h-auto w-full cursor-pointer', className)}
      onClick={() => navigate('home')}
      role="img"
      aria-label="Hyperpipe"
    >
      {outlineCells.map((cell) => (
        <rect
          key={`outline:${cell.col}:${cell.row}`}
          x={PADDING_X + cell.col * CELL_WIDTH}
          y={PADDING_Y + cell.row * CELL_HEIGHT}
          width={CELL_WIDTH}
          height={CELL_HEIGHT}
          fill={palette.outline}
        />
      ))}
      {coloredCells.map((cell) => (
        <rect
          key={`${cell.col}:${cell.row}`}
          x={PADDING_X + cell.col * CELL_WIDTH}
          y={PADDING_Y + cell.row * CELL_HEIGHT}
          width={CELL_WIDTH}
          height={CELL_HEIGHT}
          fill={cell.fill}
        />
      ))}
    </svg>
  )
}
