import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { SiteLogo } from './components/SiteLogo'
import { DownloadGroup } from './components/DownloadGroup'
import { SiteLayout } from './components/Layout'
import { homepageSections } from './data/homepage'
import { desktopRelease, gatewayPage, tuiRelease, type DownloadPageData } from './data/releases'

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}

function DownloadIcon() {
  return (
    <svg
      className="download-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 2.5V9.25M8 9.25L5.5 6.75M8 9.25L10.5 6.75M3 11.75H13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DownloadDrawer({ data }: { data: DownloadPageData }) {
  return (
    <>
      <section className="content-card prose-block">
        <h2>{data.title}</h2>
        <p className="drawer-version">Version {data.version}</p>
        <p>{data.summary}</p>
        <p>
          Full release notes and checksums are available on{' '}
          <a href={data.releaseUrl} target="_blank" rel="noreferrer">
            GitHub Releases
          </a>
          .
        </p>
      </section>
      <div className="download-grid">
        {data.groups.map((group) => (
          <DownloadGroup key={group.os} group={group} />
        ))}
      </div>
    </>
  )
}

function GatewayDrawer() {
  return (
    <>
      <section className="content-card prose-block">
        <h2>{gatewayPage.title}</h2>
        <p>{gatewayPage.summary}</p>
        <div className="action-row">
          <a
            className="primary-action"
            href={gatewayPage.primaryHref}
            target="_blank"
            rel="noreferrer"
          >
            {gatewayPage.primaryLabel}
          </a>
          <a
            className="secondary-action"
            href={gatewayPage.secondaryHref}
            target="_blank"
            rel="noreferrer"
          >
            {gatewayPage.secondaryLabel}
          </a>
        </div>
      </section>
    </>
  )
}

function TreeSection({
  title,
  defaultExpanded,
  children
}: {
  title: string
  defaultExpanded: boolean
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <section className="tree-section">
      <button
        type="button"
        className="tree-section__toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="tree-section__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span>{title}</span>
      </button>
      {expanded ? <div className="tree-section__content">{children}</div> : null}
    </section>
  )
}

function HomePage() {
  function handleSoftwareLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault()
    window.history.pushState({}, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return (
    <SiteLayout
      title="Nostr relays that run where your network lives."
      eyebrow="hyperpipe.io"
      hideHeader
      hidePageHero
    >
      <section className="hero-card">
        <div className="hero-card__logo">
          <SiteLogo />
        </div>
      </section>

      <div className="tree-root">
        <TreeSection title="About" defaultExpanded={false}>
          <section className="content-card prose-block">
            {homepageSections.about.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <h3>What You Can Build</h3>
            <p>{homepageSections.whatYouCanBuildIntro}</p>
            <ul className="feature-list">
              {homepageSections.whatYouCanBuildItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>{homepageSections.whatYouCanBuildOutro}</p>
          </section>
        </TreeSection>

        <TreeSection title="Software" defaultExpanded>
          <section className="content-card prose-block">
            <div className="software-stack">
              {homepageSections.software.map((item) => (
                <article key={item.name} className="software-card">
                  <div className="software-card__topline">
                    <a
                      className="software-link"
                      href={item.href}
                      onClick={(event) => handleSoftwareLink(event, item.href)}
                    >
                      <DownloadIcon />
                      <span>{item.name}</span>
                    </a>
                  </div>
                  <ul className="software-card__summary">
                    <li>{item.description}</li>
                  </ul>
                  {'tips' in item && item.tips ? (
                    <div className="tip-panel">
                      <div className="tip-panel__title">Tip</div>
                      <ul>
                        {item.tips.map((tip) => (
                          <li key={tip}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>

            <h3>Source Code</h3>
            <p>github:</p>
            <p>
              <a href={homepageSections.sourceCode.github} target="_blank" rel="noreferrer">
                {homepageSections.sourceCode.github}
              </a>
            </p>
            <p>npm:</p>
            <div className="command-list">
              {homepageSections.sourceCode.npmPackages.map((command) => (
                <code key={command}>{command}</code>
              ))}
            </div>
          </section>
        </TreeSection>
      </div>

      <section className="content-card prose-block credits-note">
        <p>
          Special thanks to{' '}
          <a href="https://github.com/holepunchto" target="_blank" rel="noreferrer">
            the Holepunch team
          </a>
          , who created the p2p primitive libraries that were used to build hyperpipe-core, and to
          the creators of{' '}
          <a href="https://github.com/dtonon/fevela" target="_blank" rel="noreferrer">
            Fevela
          </a>{' '}
          and{' '}
          <a href="https://github.com/CodyTseng/jumble" target="_blank" rel="noreferrer">
            Jumble
          </a>
          , which were forked to create the front-end for Hyperpipe Desktop.
        </p>
      </section>
    </SiteLayout>
  )
}

function NotFoundPage() {
  return (
    <SiteLayout title="Page not found" eyebrow="404">
      <section className="content-card prose-block">
        <p>The requested page does not exist.</p>
        <p>
          Return to <a href="/">hyperpipe.io</a>.
        </p>
      </section>
    </SiteLayout>
  )
}

export default function App() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname))

  useEffect(() => {
    function handlePopState() {
      setPath(normalizePath(window.location.pathname))
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  let drawerTitle: string | null = null
  let drawerContent: ReactNode = null

  switch (path) {
    case '/':
      break
    case '/download/hyperpipe-desktop':
      drawerTitle = desktopRelease.title
      drawerContent = <DownloadDrawer data={desktopRelease} />
      break
    case '/download/hyperpipe-tui':
      drawerTitle = tuiRelease.title
      drawerContent = <DownloadDrawer data={tuiRelease} />
      break
    case '/download/hyperpipe-gateway':
      drawerTitle = gatewayPage.title
      drawerContent = <GatewayDrawer />
      break
    default:
      return <NotFoundPage />
  }

  function closeDrawer() {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return (
    <>
      <HomePage />
      {drawerTitle ? (
        <div className="drawer-root" role="presentation">
          <button
            type="button"
            className="drawer-backdrop"
            aria-label="Close panel"
            onClick={closeDrawer}
          />
          <section className="drawer-sheet" role="dialog" aria-modal="true" aria-label={drawerTitle}>
            <div className="drawer-sheet__header">
              <button
                type="button"
                className="drawer-sheet__dismiss"
                onClick={closeDrawer}
                aria-label="Close panel"
              >
                ˅
              </button>
            </div>
            <div className="drawer-sheet__body">{drawerContent}</div>
          </section>
        </div>
      ) : null}
    </>
  )
}
