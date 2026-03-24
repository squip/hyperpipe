import './i18n'
import './index.css'
import './polyfill'
import './services/lightning.service'
import { installConsoleFileLogger } from './lib/console-file-logger'

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initNostrWasm } from 'nostr-wasm/gzipped'
import { setNostrWasm, verifyEvent } from '@nostr/tools/wasm'
import { AbstractSimplePool } from '@nostr/tools/abstract-pool'
import { pool, setPool } from '@nostr/gadgets/global'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import DesktopSplashGate from './components/DesktopSplashGate.tsx'

installConsoleFileLogger()

window.addEventListener('resize', setVh)
window.addEventListener('orientationchange', setVh)
setVh()

function BootstrapApp() {
  const [wasmReady, setWasmReady] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    initNostrWasm()
      .then((nw) => {
        if (cancelled) return
        setNostrWasm(nw)
        setPool(new AbstractSimplePool({ verifyEvent }))
        pool.trackRelays = true
        setWasmReady(true)
      })
      .catch((error) => {
        if (cancelled) return
        const message =
          error instanceof Error ? error.message : 'Failed to initialize the application runtime.'
        console.error('Failed to initialize nostr-wasm:', error)
        setBootError(message)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const bootSettled = wasmReady || Boolean(bootError)

  return (
    <ErrorBoundary>
      <DesktopSplashGate ready={bootSettled}>
        {wasmReady ? <App /> : null}
        {bootError ? (
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black px-6">
            <div className="w-full max-w-md rounded-xl border border-red-500/40 bg-neutral-950 p-6 text-center text-white shadow-2xl">
              <h2 className="mb-3 text-lg font-semibold">Browser not supported</h2>
              <p className="text-sm leading-6 text-neutral-300">
                Your browser does not support the runtime features required to launch this app.
                Try updating the browser or enabling WebAssembly support.
              </p>
              <p className="mt-4 text-xs text-neutral-500">{bootError}</p>
            </div>
          </div>
        ) : null}
      </DesktopSplashGate>
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(<BootstrapApp />)

function setVh() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`)
}
