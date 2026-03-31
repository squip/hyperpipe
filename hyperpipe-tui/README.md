# Hyperpipe TUI (Ink)

Terminal UI implementation of the Hyperpipe client, backed by `@squip/hyperpipe-core` through the shared `@squip/hyperpipe-core-host` launcher contract.

## Development

```bash
npm install
npm run dev
```

Build + run binary entry:

```bash
npm run build
node dist/cli.js
```

## Release Model

- portable bundles are the primary end-user distribution path
- npm publication is a secondary install path for terminal users and automation

## Join Behavior Defaults

The default production behavior now ships in `@squip/hyperpipe-core`, so users do
not need to pass manual join-tuning env vars just to start the app.

These env vars remain available only as explicit runtime overrides:

- `JOIN_DIRECT_DISCOVERY_V2`
- `JOIN_TOTAL_DEADLINE_MS`
- `RELAY_PROTOCOL_REQUEST_TIMEOUT_MS`
- `DIRECT_JOIN_VERIFY_TIMEOUT_MS`

## CLI flags

- `--storage-dir <path>`
- `--profile <pubkey>`
- `--no-animations`
- `--log-level <debug|info|warn|error>`

## File logging

Set `TUI_LOG_FILE` to an absolute path to enable structured JSONL logging without shell redirection.

```bash
TUI_LOG_FILE=/var/log/hyperpipe/tui.log npm run start
```

Each line is a JSON object with fields like `ts`, `level`, `source`, `message`, and `pid`, including mirrored `worker.stdout` / `worker.stderr` entries.

Set `TUI_STDIO_LOG_FILE` to an absolute path to capture raw terminal stdout/stderr output (the same stream you normally see on screen).

```bash
TUI_STDIO_LOG_FILE=/var/log/hyperpipe/tui-stdio.log npm run dev
```

## Navigation

- `Tab`: cycle focus `Left Tree -> Right Top -> Right Bottom`
- `Shift+Tab`: cycle focus in reverse
- Left tree: `Up/Down` move cursor, `Right` expand/go child, `Left` collapse/go parent, `Enter` activate/toggle
- Right top: `Up/Down/PageUp/PageDown/Home/End`, `Enter` expand parent row or execute child action
- Right bottom: `Up/Down` scroll details, `Ctrl+U`/`Ctrl+D` page scroll
- `P2P Relays -> Create Relay` and `Chats -> Create Chat`: default is browse view; `Enter` on a field opens edit mode, `Enter` saves, `Esc` cancels.
- Create browse view includes inline picker rows:
  - `Create Relay`: gateway picker rows (`Enter` selects gateway, plus refresh row)
  - `Create Chat`: writable relay checklist rows (`Enter` toggles relay)
- `Dashboard` right-top now exposes action rows:
  - `User Profile: <name>` -> `Edit Profile` opens kind 0 name/bio edit mode
  - `Discovery Relays: <N>` -> `Edit Discovery Relays` opens relay checklist/manual-add mode
  - `Terminal Commands` -> `Open Command Reference` opens read-only command docs
- `My Relays` and `Chats`: expand a row and choose `Send Invite` to open invite compose edit mode in right-top
- `r`: refresh current section
- `:`: open command bar
- `y`: copy primary selected value
- `Y`: copy context-aware command snippet
- `q`: quit

## Left Tree Nodes

- `Dashboard`
- `P2P Relays`
  - `Browse Relays`
  - `My Relays (N)`
  - `Create Relay`
- `Chats`
  - `Create Chat`
- `Invites`
  - `Relay Invites (N)`
  - `Chat Invites (N)`
- `Files (N)`
  - `Images (N)`
  - `Video (N)`
  - `Audio (N)`
  - `Docs (N)`
  - `Other (N)`
- `Accounts`

## Startup Auth Gate (Post-Splash)

Normal interactive startup now runs through an authentication/setup gate immediately after splash.

- If no stored accounts exist:
  - `Generate New Account` or `Sign In With Existing nsec`
  - generated-account flow shows full key material and requires explicit continue
  - generated-account flow includes profile setup (`name` required, `bio` optional) with kind 0 publish (`retry` or `skip`)
  - discovery relay selection step is required before entering main UI
- If stored accounts exist:
  - auth menu: `Sign In With Saved Account`, `Generate New Account`, `Sign In With Existing nsec`
  - saved-account path opens account picker and prompts password for `ncryptsec` accounts
  - generate/import paths include discovery relay selection before bootstrap
- Discovery relay step:
  - default list is pre-populated and selected
  - manual `ws://` or `wss://` URL add appends to the checklist and selects it
  - final selection persists per account and becomes the active runtime discovery relay set
- Scripted mode bypasses the startup gate (`scriptedCommands` path remains non-interactive).

## Context-first copy workflow

- Most commands infer IDs from the selected row in the right-top pane.
- `copy selected` copies the current row's primary value.
- `copy <field>` copies explicit fields like `relay-id` (`group-id` is still accepted), `invite-id`, `relay`, `conversation-id`, `url`, `sha256`.
- `copy command [workflow]` copies a workflow command template for the current selection.
- Secret material (`nsec`, tokens, writer secrets) is blocked by default.
- Set `HYPERPIPE_TUI_ALLOW_UNSAFE_COPY=1` only for explicit debug use.

## Dashboard Actions

- `Dashboard` uses expand-then-open action-tree behavior in right-top.
- `Edit Profile`:
  - edit `Name` and `Bio`, then `Submit`
  - publishes kind 0 metadata using open relay URLs first, with discovery-relay fallback
- `Edit Discovery Relays`:
  - toggle selected relays
  - add manual `ws://` / `wss://` relay URLs
  - submit to update active runtime discovery relay set
- `Open Command Reference` is read-only and scrollable (`↑/↓`, `PageUp/PageDown`, `Home/End`).

## Table-style views

- Dense list views in the right-top pane now render with compact headers and aligned columns (for relays, invites, files, chats, and accounts).
- Child action rows remain expandable/collapsible and render as indented action rows within the same table.
- `Create Relay` and `Create Chat` use a two-state browse/edit flow in right-top (browse rows by default; focused field enters edit mode).
- Right-bottom details automatically switch to a `Field | Value` key/value table when the content is primarily metadata; mixed narrative/status blocks continue to render as plain wrapped text.
- On narrow terminals, lower-priority columns are dropped before truncation to preserve readability.

## User-facing sections removed

- Feed
- Bookmarks
- Lists
- Search

## Core command examples

- `help`
- `copy selected|<field>|command [workflow]`
- `account generate [profileName]`
- `account profiles`
- `account login <index|pubkey|label> [password]`
- `account add-nsec <nsec> [label]`
- `account add-ncryptsec <ncryptsec> <password> [label]`
- `account select <index|pubkey|label>`
- `account unlock [password]`
- `worker start|stop|restart`
- `relay tab <browse|my|create|invites>`
- `relay refresh`
- `relay invites`
- `relay members [relayId]`
- `relay search <query|clear>`
- `relay sort <name|description|open|public|admin|createdAt|members|peers> [asc|desc]`
- `relay filter visibility <all|public|private>`
- `relay filter join <all|open|closed>`
- `relay create <name> --public --open`
- `relay join [publicIdentifierOrRelayKey] [token]`
- `relay disconnect <relayKey>`
- `relay leave <publicIdentifierOrRelayKey> [--archive] [--save-files]`
- `relay join-flow [publicIdentifier] [token]`
- `relay request-invite [relayId] [code] [reason]`
- `relay invite [relayId] [relayUrl] <inviteePubkey> [token]`
- `relay invite-accept [inviteId]`
- `relay invite-dismiss [inviteId]`
- `relay join-requests [relayId]`
- `relay approve [relayId] <pubkey>`
- `relay reject [relayId] <pubkey>`
- `relay update-members [relayKeyOrIdentifier] add|remove <pubkey>`
- `relay update-auth [relayKeyOrIdentifier] <pubkey> <token>`
- `invites refresh`
- `invites accept <relay|chat> [inviteId]`
- `invites dismiss <relay|chat> [inviteId]`
- `post <content>`
- `reply <eventId> <eventPubkey> <content>`
- `react <eventId> <eventPubkey> <reaction>`
- `file refresh [groupId]`
- `file upload <groupIdOrRelayKey> <absolutePath>`
- `file download [eventId|sha256]`
- `file delete [eventId|sha256]`
- `chat init|refresh`
- `chat create <title> <pubkey1,pubkey2,...> [description]`
- `chat invite [conversationId] <pubkey1,pubkey2,...>`
- `chat accept [inviteId]`
- `chat dismiss [inviteId]`
- `chat thread <conversationId>`
- `chat send <conversationId> <content>`
- `goto <dashboard|relays|relay:browse|relay:my|relay:create|chats|chats:create|invites|invites:group|invites:chat|files|files:images|files:video|files:audio|files:docs|files:other|accounts>`

`help` and the Dashboard `Terminal Commands` view are generated from the same command catalog source.


## Tests

```bash
npm test
npx tsc --noEmit
```

## Scripted Walkthroughs

Mocked walkthrough (deterministic, no real network side effects):

```bash
npm run demo:e2e
npm run demo:e2e:stay-open
```

Real worker/backend walkthrough:

```bash
npm run demo:e2e:real
npm run demo:e2e:real -- --stay-open
npm run demo:e2e:real:matrix
npm run demo:e2e:real:two-user
```

The real walkthrough can:

- use existing stored profiles (`account login` flow),
- import provided credentials (`--nsec` or `--ncryptsec --password`), or
- auto-generate a fresh nsec profile when none are available.

Optional bootstrap credentials and options:

```bash
npm run demo:e2e:real -- --nsec <nsec>
npm run demo:e2e:real -- --ncryptsec <ncryptsec> --password <password>
npm run demo:e2e:real -- --storage-dir <path> --profile <pubkey>
```

Environment variable fallbacks:

- `HYPERPIPE_TUI_NSEC`
- `HYPERPIPE_TUI_NCRYPTSEC`
- `HYPERPIPE_TUI_PASSWORD`
- `HYPERPIPE_TUI_INVITEE_PUBKEY`
- `HYPERPIPE_TUI_JOIN_ID`

Matrix runner output options:

- `npm run demo:e2e:real:matrix -- --json-out ./artifacts/live-matrix.json`
- `npm run demo:e2e:real:two-user -- --json-out ./artifacts/live-two-user.json`
