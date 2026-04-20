import type { ReactNode } from 'react'

export function SiteLayout({
  title,
  eyebrow,
  children
}: {
  title: string
  eyebrow?: string
  children: ReactNode
}) {
  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="site-brand" href="/">
          hyperpipe.io
        </a>
        <nav className="site-nav" aria-label="Site">
          <a href="/">About</a>
          <a href="/download/hyperpipe-desktop">Desktop</a>
          <a href="/download/hyperpipe-tui">Terminal</a>
          <a href="/download/hyperpipe-gateway">Gateway</a>
        </nav>
      </header>
      <main className="site-main">
        <section className="page-hero">
          {eyebrow ? <div className="page-hero__eyebrow">{eyebrow}</div> : null}
          <h1>{title}</h1>
        </section>
        {children}
      </main>
    </div>
  )
}
