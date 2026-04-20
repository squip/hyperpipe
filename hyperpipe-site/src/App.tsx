import { SiteLogo } from './components/SiteLogo'
import { DownloadGroup } from './components/DownloadGroup'
import { SiteLayout } from './components/Layout'
import { homepageSections } from './data/homepage'
import { desktopRelease, gatewayPage, tuiRelease, type DownloadPageData } from './data/releases'

function DownloadPage({ data }: { data: DownloadPageData }) {
  return (
    <SiteLayout title={data.title} eyebrow={`Version ${data.version}`}>
      <section className="content-card prose-block">
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
    </SiteLayout>
  )
}

function GatewayPage() {
  return (
    <SiteLayout title={gatewayPage.title} eyebrow="Deploy Source">
      <section className="content-card prose-block">
        <p>{gatewayPage.summary}</p>
        <div className="action-row">
          <a className="primary-action" href={gatewayPage.primaryHref} target="_blank" rel="noreferrer">
            {gatewayPage.primaryLabel}
          </a>
          <a className="secondary-action" href={gatewayPage.secondaryHref} target="_blank" rel="noreferrer">
            {gatewayPage.secondaryLabel}
          </a>
        </div>
      </section>
    </SiteLayout>
  )
}

function HomePage() {
  return (
    <SiteLayout title="Nostr relays that run where your network lives." eyebrow="hyperpipe.io">
      <section className="hero-card">
        <div className="hero-card__logo">
          <SiteLogo />
        </div>
        <p className="hero-card__lede">
          Hyperpipe is a decentralized communication platform for creating and sharing Nostr relays
          from your own device without falling back to hosted relay infrastructure.
        </p>
      </section>

      <section className="content-card prose-block">
        <h2>About Hyperpipe</h2>
        {homepageSections.about.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </section>

      <section className="content-card prose-block">
        <h2>What You Can Build</h2>
        <p>{homepageSections.whatYouCanBuildIntro}</p>
        <ul className="feature-list">
          {homepageSections.whatYouCanBuildItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>{homepageSections.whatYouCanBuildOutro}</p>
      </section>

      <section className="content-card prose-block">
        <h2>Software</h2>
        <div className="software-stack">
          {homepageSections.software.map((item) => (
            <article key={item.name} className="software-card">
              <div className="software-card__topline">
                <a href={item.href}>{item.name}</a>
              </div>
              <p>{item.description}</p>
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
      </section>

      <section className="content-card prose-block">
        <h2>Source Code</h2>
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

      <section className="content-card prose-block">
        <h2>Credits</h2>
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
  const path = window.location.pathname.replace(/\/+$/, '') || '/'

  switch (path) {
    case '/':
      return <HomePage />
    case '/download/hyperpipe-desktop':
      return <DownloadPage data={desktopRelease} />
    case '/download/hyperpipe-tui':
      return <DownloadPage data={tuiRelease} />
    case '/download/hyperpipe-gateway':
      return <GatewayPage />
    default:
      return <NotFoundPage />
  }
}
