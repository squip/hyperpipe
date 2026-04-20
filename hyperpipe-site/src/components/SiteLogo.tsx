import { getHyperpipeWordmarkLayout } from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'

const CELL_HEIGHT = 18
const CELL_WIDTH = Math.round(CELL_HEIGHT * 0.62)
const LETTER_GAP = 2
const EXTRUSION_MID_OFFSET_X = 3
const EXTRUSION_MID_OFFSET_Y = 4
const EXTRUSION_BACK_OFFSET_X = 5
const EXTRUSION_BACK_OFFSET_Y = 8
const FACE_HIGHLIGHT_HEIGHT = 3
const PADDING_X = 12
const PADDING_Y = 12
const FACE_FILL = '#1ef2b0'
const FACE_HIGHLIGHT_FILL = '#9fffe1'
const EXTRUSION_MID_FILL = '#0f6b59'
const EXTRUSION_BACK_FILL = '#093f35'

function getCellKey(col: number, row: number) {
  return `${col}:${row}`
}

export function SiteLogo() {
  const wordmark = getHyperpipeWordmarkLayout(LETTER_GAP)
  const occupiedCells = new Set(wordmark.cells.map((cell) => getCellKey(cell.col, cell.row)))
  const viewBoxWidth = wordmark.width * CELL_WIDTH + PADDING_X * 2 + EXTRUSION_BACK_OFFSET_X
  const viewBoxHeight = wordmark.height * CELL_HEIGHT + PADDING_Y * 2 + EXTRUSION_BACK_OFFSET_Y

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMinYMid meet"
      shapeRendering="crispEdges"
      className="site-logo"
      role="img"
      aria-label="Hyperpipe"
    >
      {wordmark.cells.map((cell) => {
        const x = PADDING_X + cell.col * CELL_WIDTH
        const y = PADDING_Y + cell.row * CELL_HEIGHT
        const hasRightNeighbor = occupiedCells.has(getCellKey(cell.col + 1, cell.row))
        const hasBottomNeighbor = occupiedCells.has(getCellKey(cell.col, cell.row + 1))
        const hasBottomRightNeighbor = occupiedCells.has(getCellKey(cell.col + 1, cell.row + 1))
        const shouldRenderExtrusion =
          !hasRightNeighbor || !hasBottomNeighbor || !hasBottomRightNeighbor

        return (
          <g key={`${cell.col}:${cell.row}`}>
            {shouldRenderExtrusion ? (
              <>
                <rect
                  x={x + EXTRUSION_BACK_OFFSET_X}
                  y={y + EXTRUSION_BACK_OFFSET_Y}
                  width={CELL_WIDTH}
                  height={CELL_HEIGHT}
                  fill={EXTRUSION_BACK_FILL}
                />
                <rect
                  x={x + EXTRUSION_MID_OFFSET_X}
                  y={y + EXTRUSION_MID_OFFSET_Y}
                  width={CELL_WIDTH}
                  height={CELL_HEIGHT}
                  fill={EXTRUSION_MID_FILL}
                />
              </>
            ) : null}
            <rect x={x} y={y} width={CELL_WIDTH} height={CELL_HEIGHT} fill={FACE_FILL} />
            <rect
              x={x}
              y={y}
              width={CELL_WIDTH}
              height={FACE_HIGHLIGHT_HEIGHT}
              fill={FACE_HIGHLIGHT_FILL}
            />
          </g>
        )
      })}
    </svg>
  )
}
