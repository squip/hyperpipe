import { usePrimaryPage } from '@/PageManager'
import { PRIMARY_COLORS } from '@/constants'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/lib/utils'
import { getHyperpipeWordmarkLayout } from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'
import { useMemo } from 'react'

const CELL_HEIGHT = 18
const CELL_WIDTH = Math.round(CELL_HEIGHT * 0.62)
const LETTER_GAP = 2
const EXTRUSION_MID_OFFSET_X = 3
const EXTRUSION_MID_OFFSET_Y = 4
const EXTRUSION_BACK_OFFSET_X = 5
const EXTRUSION_BACK_OFFSET_Y = 8
const FACE_HIGHLIGHT_HEIGHT = 3
const PADDING_BY_VARIANT: Record<LogoVariant, { x: number; y: number }> = {
  sidebar: { x: 6, y: 5 },
  hero: { x: 8, y: 8 }
}

type LogoVariant = 'sidebar' | 'hero'
type ResolvedLogoTheme = 'light' | 'dark' | 'pure-black'

const LIGHT_THEME_OUTLINE = '#18386f'
const LIGHT_THEME_OUTLINE_SPREAD = 1
const LIGHT_THEME_OUTLINE_OPACITY = 0.72

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function adjustHslColor(
  hslComponents: string,
  {
    hueDelta = 0,
    saturationDelta = 0,
    lightnessDelta = 0
  }: { hueDelta?: number; saturationDelta?: number; lightnessDelta?: number }
) {
  const match = hslComponents.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (!match) return `hsl(${hslComponents})`

  const [, hue, saturation, lightness] = match
  const nextHue = (Number(hue) + hueDelta + 360) % 360
  const nextSaturation = clamp(Number(saturation) + saturationDelta, 0, 100)
  const nextLightness = clamp(Number(lightness) + lightnessDelta, 0, 100)

  return `hsl(${nextHue} ${nextSaturation}% ${nextLightness}%)`
}

function getCellKey(col: number, row: number) {
  return `${col}:${row}`
}

function resolvePadding(variant: LogoVariant, theme: ResolvedLogoTheme) {
  const base = PADDING_BY_VARIANT[variant]
  if (variant === 'sidebar' && theme === 'light') {
    return { x: 4, y: 4 }
  }
  return base
}

export default function Logo({
  className,
  variant = 'sidebar'
}: {
  className?: string
  variant?: LogoVariant
}) {
  const { navigate } = usePrimaryPage()
  const { resolvedTheme, primaryColor } = useTheme()
  const theme = (resolvedTheme || 'light') as ResolvedLogoTheme
  const padding = resolvePadding(variant, theme)
  const wordmark = useMemo(() => getHyperpipeWordmarkLayout(LETTER_GAP), [])
  const occupiedCells = useMemo(
    () => new Set(wordmark.cells.map((cell) => getCellKey(cell.col, cell.row))),
    [wordmark]
  )
  const viewBoxWidth = wordmark.width * CELL_WIDTH + padding.x * 2 + EXTRUSION_BACK_OFFSET_X
  const viewBoxHeight = wordmark.height * CELL_HEIGHT + padding.y * 2 + EXTRUSION_BACK_OFFSET_Y
  const showOutline = theme === 'light'
  const colorConfig = PRIMARY_COLORS[primaryColor] ?? PRIMARY_COLORS.DEFAULT
  const toneConfig = theme === 'light' ? colorConfig.light : colorConfig.dark
  const faceFill = `hsl(${toneConfig.primary})`
  const faceHighlightFill = adjustHslColor(toneConfig.primary, {
    hueDelta: 4,
    saturationDelta: 6,
    lightnessDelta: theme === 'light' ? 12 : 14
  })
  const extrusionMidFill = adjustHslColor(toneConfig.primary, {
    hueDelta: -8,
    saturationDelta: -18,
    lightnessDelta: theme === 'light' ? -22 : -24
  })
  const extrusionBackFill = adjustHslColor(toneConfig.primary, {
    hueDelta: -14,
    saturationDelta: -28,
    lightnessDelta: theme === 'light' ? -38 : -40
  })

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMinYMid meet"
      shapeRendering="crispEdges"
      className={cn('h-auto w-full cursor-pointer', className)}
      onClick={() => navigate('home')}
      role="img"
      aria-label="Hyperpipe"
    >
      {showOutline &&
        wordmark.cells.map((cell) => {
          const x = padding.x + cell.col * CELL_WIDTH
          const y = padding.y + cell.row * CELL_HEIGHT
          return (
            <rect
              key={`outline:${cell.col}:${cell.row}`}
              x={x - LIGHT_THEME_OUTLINE_SPREAD}
              y={y - LIGHT_THEME_OUTLINE_SPREAD}
              width={CELL_WIDTH + LIGHT_THEME_OUTLINE_SPREAD * 2}
              height={CELL_HEIGHT + LIGHT_THEME_OUTLINE_SPREAD * 2}
              fill={LIGHT_THEME_OUTLINE}
              fillOpacity={LIGHT_THEME_OUTLINE_OPACITY}
            />
          )
        })}
      {wordmark.cells.map((cell) => {
        const x = padding.x + cell.col * CELL_WIDTH
        const y = padding.y + cell.row * CELL_HEIGHT
        const hasRightNeighbor = occupiedCells.has(getCellKey(cell.col + 1, cell.row))
        const hasBottomNeighbor = occupiedCells.has(getCellKey(cell.col, cell.row + 1))
        const hasBottomRightNeighbor = occupiedCells.has(getCellKey(cell.col + 1, cell.row + 1))
        const shouldRenderExtrusion =
          !hasRightNeighbor || !hasBottomNeighbor || !hasBottomRightNeighbor

        return (
          <g key={`${cell.col}:${cell.row}`}>
            {shouldRenderExtrusion && (
              <>
                <rect
                  x={x + EXTRUSION_BACK_OFFSET_X}
                  y={y + EXTRUSION_BACK_OFFSET_Y}
                  width={CELL_WIDTH}
                  height={CELL_HEIGHT}
                  fill={extrusionBackFill}
                />
                <rect
                  x={x + EXTRUSION_MID_OFFSET_X}
                  y={y + EXTRUSION_MID_OFFSET_Y}
                  width={CELL_WIDTH}
                  height={CELL_HEIGHT}
                  fill={extrusionMidFill}
                />
              </>
            )}
            <rect x={x} y={y} width={CELL_WIDTH} height={CELL_HEIGHT} fill={faceFill} />
            <rect
              x={x}
              y={y}
              width={CELL_WIDTH}
              height={FACE_HIGHLIGHT_HEIGHT}
              fill={faceHighlightFill}
            />
          </g>
        )
      })}
    </svg>
  )
}
