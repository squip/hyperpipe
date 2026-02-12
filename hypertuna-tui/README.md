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
- `q`: quit

## Core command examples

- `help`
- `account add-nsec <nsec> [label]`
- `account add-ncryptsec <ncryptsec> <password> [label]`
- `account select <pubkey>`
- `account unlock [password]`
- `worker start|stop|restart`
- `relay refresh`
- `relay create <name> --public --open`
- `relay join <publicIdentifierOrRelayKey> [token]`
- `relay disconnect <relayKey>`
- `relay leave <publicIdentifierOrRelayKey> [--archive] [--save-files]`
- `feed refresh [limit]`
- `post <content>`
- `reply <eventId> <eventPubkey> <content>`
- `react <eventId> <eventPubkey> <reaction>`
- `bookmark refresh|add <eventId>|remove <eventId>`
- `group refresh`
- `group invites`
- `group join-flow <publicIdentifier> [token]`
- `group invite <groupId> <relayUrl> <inviteePubkey> [token]`
- `group update-members <relayKeyOrIdentifier> add|remove <pubkey>`
- `group update-auth <relayKeyOrIdentifier> <pubkey> <token>`
- `file refresh [groupId]`
- `file upload <groupIdOrRelayKey> <absolutePath>`
- `list refresh`
- `list create <dTag> <title> <pubkey1,pubkey2,...> [description]`
- `list apply <dTag> [authorPubkey]`
- `chat init|refresh`
- `chat create <title> <pubkey1,pubkey2,...> [description]`
- `chat accept <inviteId>`
- `chat thread <conversationId>`
- `chat send <conversationId> <content>`
- `search <notes|profiles|groups|lists> <query>`
- `goto <dashboard|relays|feed|groups|files|lists|bookmarks|chats|search|accounts|logs>`

## Tests

```bash
npm test
npx tsc --noEmit
```
