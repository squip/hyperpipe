import { PropsWithChildren, useEffect, useState } from 'react'
import { isElectron } from '@/lib/platform'
import HyperpipeSplashScreen from './HyperpipeSplashScreen'

type DesktopSplashGateProps = PropsWithChildren<{
  ready?: boolean
}>

export default function DesktopSplashGate({
  children,
  ready = true
}: DesktopSplashGateProps) {
  const electron = isElectron()
  const [animationComplete, setAnimationComplete] = useState(false)
  const [fading, setFading] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (!electron) {
    return <>{children}</>
  }

  useEffect(() => {
    if (dismissed) return
    if (!animationComplete || !ready) return

    setFading(true)
    const timeoutId = window.setTimeout(() => {
      setDismissed(true)
    }, 280)

    return () => window.clearTimeout(timeoutId)
  }, [animationComplete, dismissed, ready])

  return (
    <>
      {children}
      {!dismissed ? (
        <div
          className={`fixed inset-0 z-[10000] bg-black transition-opacity duration-300 ${
            fading ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
        >
          <HyperpipeSplashScreen onComplete={() => setAnimationComplete(true)} />
        </div>
      ) : null}
    </>
  )
}
