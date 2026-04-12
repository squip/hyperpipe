import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { createRequire } from 'module'
import path from 'path'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'
import packageJson from './package.json'

const require = createRequire(import.meta.url)

const getGitHash = () => {
  try {
    return JSON.stringify(
      execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    )
  } catch (error) {
    if (!(error instanceof Error) || !`${error.message}`.includes('not a git repository')) {
      console.warn(`Failed to retrieve commit hash: ${error instanceof Error ? error.message : String(error)}`)
    }
    return '"unknown"'
  }
}

const getAppVersion = () => {
  try {
    return JSON.stringify(packageJson.version)
  } catch (error) {
    console.warn('Failed to retrieve app version:', error)
    return '"unknown"'
  }
}

const resolveBridgePackageRoot = () => {
  try {
    const packageJsonPath = require.resolve('@squip/hyperpipe-bridge/package.json')
    return path.dirname(packageJsonPath)
  } catch (_) {
    return path.resolve(__dirname, '../hyperpipe-bridge')
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  define: {
    'import.meta.env.GIT_COMMIT': getGitHash(),
    'import.meta.env.APP_VERSION': getAppVersion()
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    exclude: [
      'e2e/**',
      'electron/**',
      'release/**',
      'node_modules/**',
      '.release-deps/**',
      '.release-runtime/**'
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@squip/hyperpipe-bridge': resolveBridgePackageRoot()
    }
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')]
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,jpg,svg}'],
        globDirectory: 'dist/',
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true
      },
      devOptions: {
        enabled: true
      },
      manifest: {
        name: 'Hyperpipe',
        short_name: 'Hyperpipe',
        icons: [
          {
            src: './pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: './pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: './pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: './pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: './pwa-monochrome.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'monochrome'
          }
        ],
        start_url: './',
        display: 'standalone',
        background_color: '#050505',
        theme_color: '#050505',
        description: packageJson.description
      }
    })
  ]
})
