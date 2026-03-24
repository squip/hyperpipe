import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import chalk from 'chalk'
import {
  advanceHypertunaSplashState,
  createHypertunaSplashState,
  HYPERTUNA_SPLASH_FRAME_INTERVAL_MS,
  HYPERTUNA_SPLASH_TOTAL_FRAMES,
  renderHypertunaSplashGrid
} from '../../../shared/ui/hypertunaSplash.js'

type SplashScreenProps = {
  onComplete: () => void
}

function renderGrid(grid: ReturnType<typeof renderHypertunaSplashGrid>): string {
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
  const stateRef = useRef<ReturnType<typeof createHypertunaSplashState> | null>(null)
  const completionScheduledRef = useRef(false)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    const termCols = Number(stdout.columns || 80)
    const termRows = Number(stdout.rows || 24)

    stateRef.current = createHypertunaSplashState(termCols, termRows)

    process.stdout.write('\x1B[?25l')
    setOutput(renderGrid(renderHypertunaSplashGrid(stateRef.current)))

    const interval = setInterval(() => {
      const state = stateRef.current
      if (!state) return

      const nextFrame = Math.min(HYPERTUNA_SPLASH_TOTAL_FRAMES, state.frame + 1)
      advanceHypertunaSplashState(state, nextFrame)
      setOutput(renderGrid(renderHypertunaSplashGrid(state)))

      if (state.frame >= HYPERTUNA_SPLASH_TOTAL_FRAMES && !completionScheduledRef.current) {
        completionScheduledRef.current = true
        clearInterval(interval)
        process.stdout.write('\x1B[?25h')
        setTimeout(() => {
          onCompleteRef.current()
        }, 220)
      }
    }, HYPERTUNA_SPLASH_FRAME_INTERVAL_MS)

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
