import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import chalk from 'chalk'
import {
  advanceHyperpipeSplashState,
  createHyperpipeSplashState,
  getHyperpipeSplashTargetFrame,
  HYPERPIPE_SPLASH_DESKTOP_DURATION_MS,
  HYPERPIPE_SPLASH_TOTAL_FRAMES,
  renderHyperpipeSplashGrid
} from '@squip/hyperpipe-bridge/ui/hyperpipeSplash'

type SplashScreenProps = {
  onComplete: () => void
}

const REDRAW_INTERVAL_MS = 33

function renderGrid(grid: ReturnType<typeof renderHyperpipeSplashGrid>): string {
  return grid
    .map((row) =>
      row
        .map((cell) => {
          if (!cell) return ' '
          return chalk.hex(cell.color)(cell.char)
        })
        .join('')
    )
    .join('\n')
}

export function SplashScreen({ onComplete }: SplashScreenProps): React.JSX.Element {
  const { stdout } = useStdout()
  const [output, setOutput] = useState('')
  const stateRef = useRef<ReturnType<typeof createHyperpipeSplashState> | null>(null)
  const completionScheduledRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const termCols = Number(stdout.columns || 80)
    const termRows = Number(stdout.rows || 24)

    stateRef.current = createHyperpipeSplashState(termCols, termRows)
    startedAtRef.current = Date.now()

    process.stdout.write('\x1B[?25l')
    setOutput(renderGrid(renderHyperpipeSplashGrid(stateRef.current)))

    const interval = setInterval(() => {
      const state = stateRef.current
      if (!state) return

      const startedAt = startedAtRef.current ?? Date.now()
      const elapsedMs = Date.now() - startedAt
      const targetFrame = getHyperpipeSplashTargetFrame(
        elapsedMs,
        HYPERPIPE_SPLASH_DESKTOP_DURATION_MS
      )
      advanceHyperpipeSplashState(state, targetFrame)
      setOutput(renderGrid(renderHyperpipeSplashGrid(state)))

      if (state.frame >= HYPERPIPE_SPLASH_TOTAL_FRAMES && !completionScheduledRef.current) {
        completionScheduledRef.current = true
        clearInterval(interval)
        process.stdout.write('\x1B[?25h')
        setTimeout(() => {
          onCompleteRef.current()
        }, 220)
      }
    }, REDRAW_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      process.stdout.write('\x1B[?25h')
    }
  }, [stdout])

  return (
    <Box flexDirection="column">
      <Text>{output}</Text>
    </Box>
  )
}
