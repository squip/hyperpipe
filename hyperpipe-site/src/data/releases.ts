export type DownloadLink = {
  label: string
  href: string
  trackingPath: string
}

export type DownloadGroup = {
  os: string
  links: DownloadLink[]
}

export type DownloadPageData = {
  title: string
  summary: string
  version: string
  releaseUrl: string
  releaseTrackingPath: string
  groups: DownloadGroup[]
}

export const desktopRelease: DownloadPageData = {
  title: 'Hyperpipe Desktop',
  summary:
    'Download the latest desktop client release for macOS, Windows, and Linux. Files are grouped by operating system and architecture.',
  version: '0.1.21',
  releaseUrl: 'https://github.com/squip/hyperpipe/releases/tag/desktop-v0.1.21',
  releaseTrackingPath: '/go/desktop/release-notes',
  groups: [
    {
      os: 'macOS',
      links: [
        {
          label: 'Apple Silicon (.dmg)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64.dmg',
          trackingPath: '/go/desktop/macos-arm64-dmg'
        },
        {
          label: 'Apple Silicon (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64-mac.zip',
          trackingPath: '/go/desktop/macos-arm64-zip'
        },
        {
          label: 'Intel (.dmg)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21.dmg',
          trackingPath: '/go/desktop/macos-x64-dmg'
        },
        {
          label: 'Intel (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-mac.zip',
          trackingPath: '/go/desktop/macos-x64-zip'
        }
      ]
    },
    {
      os: 'Windows',
      links: [
        {
          label: 'Windows x64 Installer',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe.Setup.0.1.21.x64.exe',
          trackingPath: '/go/desktop/windows-x64'
        },
        {
          label: 'Windows ARM64 Installer',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe.Setup.0.1.21.arm64.exe',
          trackingPath: '/go/desktop/windows-arm64'
        }
      ]
    },
    {
      os: 'Linux',
      links: [
        {
          label: 'Linux x64 AppImage',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21.AppImage',
          trackingPath: '/go/desktop/linux-x64'
        },
        {
          label: 'Linux ARM64 AppImage',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64.AppImage',
          trackingPath: '/go/desktop/linux-arm64'
        }
      ]
    }
  ]
}

export const tuiRelease: DownloadPageData = {
  title: 'Hyperpipe Terminal',
  summary:
    'Download the latest terminal client release for macOS, Windows, and Linux. These packages are suitable for relay management on laptops, servers, and hosted VPS environments.',
  version: '0.1.12',
  releaseUrl: 'https://github.com/squip/hyperpipe/releases/tag/tui-v0.1.12',
  releaseTrackingPath: '/go/tui/release-notes',
  groups: [
    {
      os: 'macOS',
      links: [
        {
          label: 'Apple Silicon (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-macos-arm64.zip',
          trackingPath: '/go/tui/macos-arm64'
        },
        {
          label: 'Intel (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-macos-x64.zip',
          trackingPath: '/go/tui/macos-x64'
        }
      ]
    },
    {
      os: 'Windows',
      links: [
        {
          label: 'Windows x64 Portable Bundle',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-windows-x64.zip',
          trackingPath: '/go/tui/windows-x64'
        },
        {
          label: 'Windows ARM64 Portable Bundle',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-windows-arm64.zip',
          trackingPath: '/go/tui/windows-arm64'
        }
      ]
    },
    {
      os: 'Linux',
      links: [
        {
          label: 'Linux x64 Bundle (.tar.gz)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-linux-x64.tar.gz',
          trackingPath: '/go/tui/linux-x64'
        },
        {
          label: 'Linux ARM64 Bundle (.tar.gz)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-linux-arm64.tar.gz',
          trackingPath: '/go/tui/linux-arm64'
        }
      ]
    }
  ]
}

export const gatewayPage = {
  title: 'Hyperpipe Gateway',
  summary:
    'Run Hyperpipe Gateway on a VPS or home server using the included Docker setup and built-in configuration wizard. It gives trusted Hyperpipe relays an easy hosted edge service for staying reachable, mirrored, and accessible remotely.',
  primaryHref: 'https://github.com/squip/hyperpipe/tree/main/deploy',
  primaryLabel: 'Open Gateway Setup on GitHub',
  primaryTrackingPath: '/go/gateway/setup',
  secondaryHref: 'https://github.com/squip/hyperpipe',
  secondaryLabel: 'Open Main Hyperpipe Repository',
  secondaryTrackingPath: '/go/gateway/repository'
} as const

export type TrackedRedirect = {
  path: string
  href: string
  label: string
}

export function buildTrackedRedirects() {
  const redirects: TrackedRedirect[] = []

  function pushRelease(data: DownloadPageData) {
    redirects.push({
      path: data.releaseTrackingPath,
      href: data.releaseUrl,
      label: `${data.title} release notes`
    })
    for (const group of data.groups) {
      for (const link of group.links) {
        redirects.push({
          path: link.trackingPath,
          href: link.href,
          label: `${data.title} ${link.label}`
        })
      }
    }
  }

  pushRelease(desktopRelease)
  pushRelease(tuiRelease)

  redirects.push({
    path: gatewayPage.primaryTrackingPath,
    href: gatewayPage.primaryHref,
    label: gatewayPage.primaryLabel
  })
  redirects.push({
    path: gatewayPage.secondaryTrackingPath,
    href: gatewayPage.secondaryHref,
    label: gatewayPage.secondaryLabel
  })

  return redirects
}
