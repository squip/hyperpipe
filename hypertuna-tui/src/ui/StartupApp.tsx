import React, { useCallback, useState } from 'react'
import type { RuntimeOptions } from '../domain/controller.js'
import { App, type AppController, type ScriptedCommand } from './App.js'
import { SplashScreen } from './SplashScreen.js'

type StartupAppProps = {
  options: RuntimeOptions
  controllerFactory?: (options: RuntimeOptions) => AppController
  scriptedCommands?: ScriptedCommand[]
  autoExitOnScriptComplete?: boolean
}

export function StartupApp({
  options,
  controllerFactory,
  scriptedCommands,
  autoExitOnScriptComplete = false
}: StartupAppProps): React.JSX.Element {
  const [splashComplete, setSplashComplete] = useState(Boolean(options.noAnimations))

  const handleSplashComplete = useCallback(() => {
    setSplashComplete(true)
  }, [])

  if (!splashComplete) {
    return <SplashScreen onComplete={handleSplashComplete} />
  }

  return (
    <App
      options={options}
      enableStartupGate
      controllerFactory={controllerFactory}
      scriptedCommands={scriptedCommands}
      autoExitOnScriptComplete={autoExitOnScriptComplete}
    />
  )
}
