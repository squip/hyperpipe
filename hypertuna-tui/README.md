# Hypertuna TUI (Ink)

Terminal UI for Hypertuna feature parity work, backed by the existing `hypertuna-worker` IPC protocol.

## Run

```bash
cd /Users/essorensen/hypertuna-electron/hypertuna-tui
npm install
npm run dev
```

Build + run binary entry:

```bash
npm run build
node dist/cli.js
```

## CLI flags

- `--storage-dir <path>`
- `--profile <pubkey>`
- `--no-animations`
- `--log-level <debug|info|warn|error>`

## Navigation

- `Tab`, `Left`, `Right`: switch sections
- `Up`, `Down`: move selection
- `r`: refresh current section
- `:`: open command bar
- `Enter`: open command bar prefilled from current selection
- `y`: copy primary selected value
- `Y`: copy context-aware command snippet
- `q`: quit

## Context-first copy workflow

- Most commands infer IDs from the selected row in the center pane.
- `copy selected` copies the current row's primary value.
- `copy <field>` copies explicit fields like `group-id`, `invite-id`, `relay`, `conversation-id`, `url`, `sha256`.
- `copy command [workflow]` copies a workflow command template for the current selection.
- Secret material (`nsec`, tokens, writer secrets) is blocked by default.
- Set `HYPERTUNA_TUI_ALLOW_UNSAFE_COPY=1` only for explicit debug use.

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
- `relay refresh`
- `relay create <name> --public --open`
- `relay join [publicIdentifierOrRelayKey] [token]`
- `relay disconnect <relayKey>`
- `relay leave <publicIdentifierOrRelayKey> [--archive] [--save-files]`
- `feed refresh [limit]`
- `post <content>`
- `reply <eventId> <eventPubkey> <content>`
- `react <eventId> <eventPubkey> <reaction>`
- `bookmark refresh|add <eventId>|remove <eventId>`
- `group refresh`
- `group invites`
- `group join-flow [publicIdentifier] [token]`
- `group invite [groupId] [relayUrl] <inviteePubkey> [token]`
- `group invite-accept [inviteId]`
- `group invite-dismiss [inviteId]`
- `group update-members [relayKeyOrIdentifier] add|remove <pubkey>`
- `group update-auth [relayKeyOrIdentifier] <pubkey> <token>`
- `file refresh [groupId]`
- `file upload <groupIdOrRelayKey> <absolutePath>`
- `list refresh`
- `list create <dTag> <title> <pubkey1,pubkey2,...> [description]`
- `list apply <dTag> [authorPubkey]`
- `chat init|refresh`
- `chat create <title> <pubkey1,pubkey2,...> [description]`
- `chat accept [inviteId]`
- `chat dismiss [inviteId]`
- `chat thread <conversationId>`
- `chat send <conversationId> <content>`
- `search <notes|profiles|groups|lists> <query>`
- `goto <dashboard|relays|feed|groups|files|lists|bookmarks|chats|search|accounts|logs>`

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

- `HYPERTUNA_TUI_NSEC`
- `HYPERTUNA_TUI_NCRYPTSEC`
- `HYPERTUNA_TUI_PASSWORD`
- `HYPERTUNA_TUI_INVITEE_PUBKEY`
- `HYPERTUNA_TUI_JOIN_ID`
