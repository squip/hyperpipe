# htplugin CLI

Plugin SDK/CLI for creating and packaging Hyperpipe plugins.

## Commands

Run from this repository:

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs <command>
```

Or from `shared/`:

```bash
npm run htplugin -- <command>
```

### `init`

Create a starter plugin project.

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs init ./my-plugin --id com.example.myplugin --name "My Plugin"
```

### `build`

Build plugin runtime artifacts (`dist/runner.mjs`).

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs build ./my-plugin
```

Optional custom build command:

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs build ./my-plugin --command "npm run build:plugin"
```

### `validate`

Validate manifest contract + integrity hashes against local project files.

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs validate ./my-plugin
```

Auto-fix integrity hashes:

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs validate ./my-plugin --fix-integrity
```

### `pack`

Build, validate, and produce deterministic `.htplugin.tgz`.

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs pack ./my-plugin
```

Set explicit output archive path:

```bash
node /Users/essorensen/hypertuna-electron/shared/plugins/sdk/htplugin-cli.mjs pack ./my-plugin --output ./artifacts/my-plugin.htplugin.tgz
```

## Notes

- `pack` writes `checksums.sha256`.
- `pack` computes integrity using the same hashing rules used by `plugin-supervisor`.
- Archives are generated with normalized ownership/permissions and fixed timestamps for deterministic output.
