import {
  advanceHypertunaSplashState,
  createHypertunaSplashState,
  getHypertunaSplashTargetFrame,
  HYPERTUNA_SPLASH_DESKTOP_DURATION_MS,
  HYPERTUNA_SPLASH_TOTAL_FRAMES,
  renderHypertunaSplashGrid
} from '@shared/ui/hypertunaSplash'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type HypertunaSplashScreenProps = {
  durationMs?: number
  onComplete?: () => void
}

type CanvasMetrics = {
  width: number
  height: number
  dpr: number
  cols: number
  rows: number
  fontSize: number
  charWidth: number
  lineHeight: number
}

const FONT_FAMILY =
  'SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function measureCanvasMetrics(width: number, height: number, dpr: number): CanvasMetrics {
  const fontSize = clamp(Math.floor(Math.min(width / 42, height / 18)), 14, 26)
  const charWidth = fontSize * 0.62
  const lineHeight = Math.max(fontSize * 1.08, fontSize + 2)
  const cols = Math.max(48, Math.floor(width / charWidth))
  const rows = Math.max(20, Math.floor(height / lineHeight))

  return {
    width,
    height,
    dpr,
    cols,
    rows,
    fontSize,
    charWidth,
    lineHeight
  }
}

function drawFrame(
  canvas: HTMLCanvasElement,
  metrics: CanvasMetrics,
  state: ReturnType<typeof createHypertunaSplashState>
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
  ctx.font = `${metrics.fontSize}px ${FONT_FAMILY}`
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'

  const grid = renderHypertunaSplashGrid(state)
  for (let row = 0; row < grid.length; row += 1) {
    const y = row * metrics.lineHeight
    const rowCells = grid[row]
    for (let col = 0; col < rowCells.length; col += 1) {
      const cell = rowCells[col]
      if (!cell) continue
      ctx.fillStyle = cell.color
      ctx.fillText(cell.char, col * metrics.charWidth, y)
    }
  }
}

export default function HypertunaSplashScreen({
  durationMs = HYPERTUNA_SPLASH_DESKTOP_DURATION_MS,
  onComplete
}: HypertunaSplashScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)
  const currentFrameRef = useRef(0)
  const completionRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const animationStateRef = useRef<ReturnType<typeof createHypertunaSplashState> | null>(null)
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
    const nextState = createHypertunaSplashState(metrics.cols, metrics.rows)
    advanceHypertunaSplashState(nextState, currentFrameRef.current)
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
      const targetFrame = getHypertunaSplashTargetFrame(elapsedMs, durationMs)
      currentFrameRef.current = targetFrame

      const currentMetrics = metricsRef.current
      const state = animationStateRef.current
      const canvas = canvasRef.current
      if (state && canvas && currentMetrics) {
        advanceHypertunaSplashState(state, targetFrame)
        drawFrame(canvas, currentMetrics, state)
      }

      if (targetFrame >= HYPERTUNA_SPLASH_TOTAL_FRAMES) {
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
