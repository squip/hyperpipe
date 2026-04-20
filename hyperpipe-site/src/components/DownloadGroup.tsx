import type { DownloadGroup as DownloadGroupType } from '../data/releases'

export function DownloadGroup({ group }: { group: DownloadGroupType }) {
  return (
    <section className="download-group">
      <div className="download-group__header">
        <h2>{group.os}</h2>
      </div>
      <div className="download-group__links">
        {group.links.map((link) => (
          <a
            key={link.href}
            className="download-link"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {link.label}
          </a>
        ))}
      </div>
    </section>
  )
}
