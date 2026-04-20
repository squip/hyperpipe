# hyperpipe-site

Static marketing and download site for `hyperpipe.io`.

## Cloudflare Pages

Recommended Pages settings:

- Production branch: `main`
- Root directory: repository root
- Build command: `npm ci && npm --workspace ./hyperpipe-site run build`
- Build output directory: `hyperpipe-site/dist`

Recommended domains:

- `hyperpipe.io` as canonical
- `www.hyperpipe.io` redirected to the apex domain
