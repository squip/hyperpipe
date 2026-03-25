import { usePrimaryPage } from '@/PageManager'
import { cn } from '@/lib/utils'
import { getHyperpipeWordmarkLayout } from '@shared/ui/hyperpipeSplash'
import { useId } from 'react'

const CELL_HEIGHT = 18
const CELL_WIDTH = Math.round(CELL_HEIGHT * 0.62)
const PADDING_X = 8
const PADDING_Y = 8
const WORDMARK = getHyperpipeWordmarkLayout()
const VIEWBOX_WIDTH = WORDMARK.width * CELL_WIDTH + PADDING_X * 2
const VIEWBOX_HEIGHT = WORDMARK.height * CELL_HEIGHT + PADDING_Y * 2
const WHITE_CELL_COLOR = '#ffffff'

export default function Logo({ className }: { className?: string }) {
  const { navigate } = usePrimaryPage()
  const gradientId = useId()

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
      <defs>
        <linearGradient
          id={gradientId}
          x1={PADDING_X}
          y1={PADDING_Y}
          x2={VIEWBOX_WIDTH - PADDING_X}
          y2={VIEWBOX_HEIGHT - PADDING_Y}
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#4ade80" />
        </linearGradient>
      </defs>
      {WORDMARK.cells.map((cell) => (
        <rect
          key={`${cell.col}:${cell.row}`}
          x={PADDING_X + cell.col * CELL_WIDTH}
          y={PADDING_Y + cell.row * CELL_HEIGHT}
          width={CELL_WIDTH}
          height={CELL_HEIGHT}
          fill={cell.color === WHITE_CELL_COLOR ? `url(#${gradientId})` : cell.color}
        />
      ))}
    </svg>
  )
}
