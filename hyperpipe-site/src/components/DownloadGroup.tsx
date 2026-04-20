import type { DownloadGroup as DownloadGroupType } from '../data/releases'

export function DownloadGroup({ group }: { group: DownloadGroupType }) {
  return (
    <section className="download-group">
      <div className="download-group__header">
        <h2>{group.os}</h2>
      </div>
      <ul className="download-group__links">
        {group.links.map((link) => (
          <li key={link.trackingPath}>
            <a className="download-link" href={link.trackingPath}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
