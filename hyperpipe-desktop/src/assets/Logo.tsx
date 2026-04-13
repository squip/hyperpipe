import { usePrimaryPage } from '@/PageManager'
import { PRIMARY_COLORS } from '@/constants'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/lib/utils'
import { getHyperpipeWordmarkLayout } from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'
import { useMemo } from 'react'

const CELL_HEIGHT = 18
const CELL_WIDTH = Math.round(CELL_HEIGHT * 0.62)
const LETTER_GAP = 2
const PADDING_BY_VARIANT: Record<LogoVariant, { x: number; y: number }> = {
  sidebar: { x: 6, y: 5 },
  hero: { x: 8, y: 8 }
}

type LogoVariant = 'sidebar' | 'hero'
type ResolvedLogoTheme = 'light' | 'dark' | 'pure-black'

const LIGHT_THEME_OUTLINE = '#18386f'
const LIGHT_THEME_OUTLINE_SPREAD = 1

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
  const viewBoxWidth = wordmark.width * CELL_WIDTH + padding.x * 2
  const viewBoxHeight = wordmark.height * CELL_HEIGHT + padding.y * 2
  const showOutline = theme === 'light'
  const colorConfig = PRIMARY_COLORS[primaryColor] ?? PRIMARY_COLORS.DEFAULT
  const fillColor = `hsl(${theme === 'light' ? colorConfig.light.primary : colorConfig.dark.primary})`

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
            />
          )
        })}
      {wordmark.cells.map((cell) => {
        const x = padding.x + cell.col * CELL_WIDTH
        const y = padding.y + cell.row * CELL_HEIGHT
        return (
          <rect
            key={`${cell.col}:${cell.row}`}
            x={x}
            y={y}
            width={CELL_WIDTH}
            height={CELL_HEIGHT}
            fill={fillColor}
          />
        )
      })}
    </svg>
  )
}
