export type DownloadLink = {
  label: string
  href: string
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
  groups: DownloadGroup[]
}

export const desktopRelease: DownloadPageData = {
  title: 'Hyperpipe Desktop',
  summary:
    'Download the latest desktop client release for macOS, Windows, and Linux. Files are grouped by operating system and architecture.',
  version: '0.1.21',
  releaseUrl: 'https://github.com/squip/hyperpipe/releases/tag/desktop-v0.1.21',
  groups: [
    {
      os: 'macOS',
      links: [
        {
          label: 'Apple Silicon (.dmg)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64.dmg'
        },
        {
          label: 'Apple Silicon (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64-mac.zip'
        },
        {
          label: 'Intel (.dmg)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21.dmg'
        },
        {
          label: 'Intel (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-mac.zip'
        }
      ]
    },
    {
      os: 'Windows',
      links: [
        {
          label: 'Windows x64 Installer',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe.Setup.0.1.21.x64.exe'
        },
        {
          label: 'Windows ARM64 Installer',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe.Setup.0.1.21.arm64.exe'
        }
      ]
    },
    {
      os: 'Linux',
      links: [
        {
          label: 'Linux x64 AppImage',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21.AppImage'
        },
        {
          label: 'Linux ARM64 AppImage',
          href: 'https://github.com/squip/hyperpipe/releases/download/desktop-v0.1.21/Hyperpipe-0.1.21-arm64.AppImage'
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
  groups: [
    {
      os: 'macOS',
      links: [
        {
          label: 'Apple Silicon (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-macos-arm64.zip'
        },
        {
          label: 'Intel (.zip)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-macos-x64.zip'
        }
      ]
    },
    {
      os: 'Windows',
      links: [
        {
          label: 'Windows x64 Portable Bundle',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-windows-x64.zip'
        },
        {
          label: 'Windows ARM64 Portable Bundle',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-windows-arm64.zip'
        }
      ]
    },
    {
      os: 'Linux',
      links: [
        {
          label: 'Linux x64 Bundle (.tar.gz)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-linux-x64.tar.gz'
        },
        {
          label: 'Linux ARM64 Bundle (.tar.gz)',
          href: 'https://github.com/squip/hyperpipe/releases/download/tui-v0.1.12/hyperpipe-tui-linux-arm64.tar.gz'
        }
      ]
    }
  ]
}

export const gatewayPage = {
  title: 'Hyperpipe Gateway',
  summary:
    'Hyperpipe Gateway is deployed from the repository deploy tooling. Use the deploy source to provision the HTTPS edge service and remote relay ingress layer.',
  primaryHref: 'https://github.com/squip/hyperpipe/tree/main/deploy',
  primaryLabel: 'Open Gateway Deploy Source',
  secondaryHref: 'https://github.com/squip/hyperpipe',
  secondaryLabel: 'Open Main Repository'
} as const
