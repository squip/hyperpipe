import {
  advanceHyperpipeSplashState,
  createHyperpipeSplashState,
  getHyperpipeSplashTargetFrame,
  HYPERPIPE_SPLASH_DESKTOP_DURATION_MS,
  HYPERPIPE_SPLASH_TOTAL_FRAMES,
  renderHyperpipeSplashGrid
} from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type HyperpipeSplashScreenProps = {
  durationMs?: number
  onComplete?: () => void
}

type CanvasMetrics = {
  width: number
  height: number
  dpr: number
  cols: number
  rows: number
  textFontSize: number
  cellWidth: number
  cellHeight: number
}

const FONT_FAMILY =
  'SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function measureCanvasMetrics(width: number, height: number, dpr: number): CanvasMetrics {
  const fontSize = clamp(Math.floor(Math.min(width / 42, height / 18)), 14, 26)
  const cellWidth = fontSize * 0.62
  const cellHeight = Math.max(fontSize * 1.08, fontSize + 2)
  const cols = Math.max(48, Math.floor(width / cellWidth))
  const rows = Math.max(20, Math.floor(height / cellHeight))

  return {
    width,
    height,
    dpr,
    cols,
    rows,
    textFontSize: fontSize,
    cellWidth,
    cellHeight
  }
}

function getCellBounds(metrics: CanvasMetrics, col: number, row: number) {
  const x = Math.round(col * metrics.cellWidth)
  const y = Math.round(row * metrics.cellHeight)
  const nextX = Math.round((col + 1) * metrics.cellWidth)
  const nextY = Math.round((row + 1) * metrics.cellHeight)
  return {
    x,
    y,
    width: Math.max(1, nextX - x),
    height: Math.max(1, nextY - y)
  }
}

function fillDitherCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  alpha: number,
  spacing: number
) {
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  for (let offsetY = 0; offsetY < height; offsetY += spacing) {
    for (let offsetX = (Math.floor(offsetY / spacing) % 2) * spacing; offsetX < width; offsetX += spacing * 2) {
      ctx.fillRect(x + offsetX, y + offsetY, Math.max(1, Math.ceil(spacing / 1.5)), Math.max(1, Math.ceil(spacing / 1.5)))
    }
  }
  ctx.restore()
}

function drawRasterCell(
  ctx: CanvasRenderingContext2D,
  metrics: CanvasMetrics,
  char: string,
  color: string,
  col: number,
  row: number
) {
  const { x, y, width, height } = getCellBounds(metrics, col, row)

  switch (char) {
    case '█':
      ctx.fillStyle = color
      ctx.fillRect(x, y, width, height)
      return
    case '▓':
      ctx.fillStyle = color
      ctx.globalAlpha = 0.35
      ctx.fillRect(x, y, width, height)
      ctx.globalAlpha = 1
      fillDitherCell(ctx, x, y, width, height, color, 0.9, Math.max(2, Math.floor(width / 3)))
      return
    case '░':
      fillDitherCell(ctx, x, y, width, height, color, 0.8, Math.max(2, Math.floor(width / 2.6)))
      return
    case '·': {
      const size = Math.max(1, Math.floor(Math.min(width, height) * 0.28))
      const dotX = x + Math.floor((width - size) / 2)
      const dotY = y + Math.floor((height - size) / 2)
      ctx.fillStyle = color
      ctx.fillRect(dotX, dotY, size, size)
      return
    }
    case '─': {
      const lineHeight = Math.max(1, Math.floor(height * 0.18))
      const lineY = y + Math.floor((height - lineHeight) / 2)
      ctx.fillStyle = color
      ctx.fillRect(x, lineY, width, lineHeight)
      return
    }
    default:
      ctx.fillStyle = color
      ctx.font = `${Math.max(10, Math.floor(metrics.textFontSize * 0.92))}px ${FONT_FAMILY}`
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText(char, x, y + Math.max(0, Math.floor((height - metrics.textFontSize) / 2)))
  }
}

function drawFrame(
  canvas: HTMLCanvasElement,
  metrics: CanvasMetrics,
  state: ReturnType<typeof createHyperpipeSplashState>
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  canvas.width = Math.max(1, Math.floor(metrics.width * metrics.dpr))
  canvas.height = Math.max(1, Math.floor(metrics.height * metrics.dpr))
  canvas.style.width = `${metrics.width}px`
  canvas.style.height = `${metrics.height}px`

  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0)
  ctx.clearRect(0, 0, metrics.width, metrics.height)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, metrics.width, metrics.height)

  const grid = renderHyperpipeSplashGrid(state)
  for (let row = 0; row < grid.length; row += 1) {
    const rowCells = grid[row]
    for (let col = 0; col < rowCells.length; col += 1) {
      const cell = rowCells[col]
      if (!cell) continue
      drawRasterCell(ctx, metrics, cell.char, cell.color, col, row)
    }
  }
}

export default function HyperpipeSplashScreen({
  durationMs = HYPERPIPE_SPLASH_DESKTOP_DURATION_MS,
  onComplete
}: HyperpipeSplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const currentFrameRef = useRef(0)
  const completionRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const animationStateRef = useRef<ReturnType<typeof createHyperpipeSplashState> | null>(null)
  const metricsRef = useRef<CanvasMetrics | null>(null)
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1
  }))

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  const metrics = useMemo(
    () => measureCanvasMetrics(viewport.width, viewport.height, viewport.dpr),
    [viewport]
  )

  useEffect(() => {
    metricsRef.current = metrics
  }, [metrics])

  useEffect(() => {
    const handleResize = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useLayoutEffect(() => {
    const nextState = createHyperpipeSplashState(metrics.cols, metrics.rows)
    advanceHyperpipeSplashState(nextState, currentFrameRef.current)
    animationStateRef.current = nextState

    const canvas = canvasRef.current
    if (canvas) {
      drawFrame(canvas, metrics, nextState)
    }
  }, [metrics])

  useEffect(() => {
    const tick = (timestamp: number) => {
      if (startTimeRef.current == null) {
        startTimeRef.current = timestamp
      }

      const elapsedMs = timestamp - startTimeRef.current
      const targetFrame = getHyperpipeSplashTargetFrame(elapsedMs, durationMs)
      currentFrameRef.current = targetFrame

      const currentMetrics = metricsRef.current
      const state = animationStateRef.current
      const canvas = canvasRef.current
      if (state && canvas && currentMetrics) {
        advanceHyperpipeSplashState(state, targetFrame)
        drawFrame(canvas, currentMetrics, state)
      }

      if (targetFrame >= HYPERPIPE_SPLASH_TOTAL_FRAMES) {
        if (!completionRef.current) {
          completionRef.current = true
          window.setTimeout(() => {
            onCompleteRef.current?.()
          }, 220)
        }
        return
      }

      animationFrameRef.current = window.requestAnimationFrame(tick)
    }

    completionRef.current = false
    startTimeRef.current = null
    currentFrameRef.current = 0
    animationFrameRef.current = window.requestAnimationFrame(tick)

    return () => {
      if (animationFrameRef.current != null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [durationMs])

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />
}
