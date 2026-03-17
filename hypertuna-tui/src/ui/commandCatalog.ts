export type CommandCatalogSection = {
  title: string
  commands: string[]
}

export const COMMAND_HELP_GROUPS: string[] = [
  'help',
  'goto <node>',
  'copy <field|selected|command>',
  'account generate/profiles/login/add-nsec/add-ncryptsec/select/unlock/remove/clear',
  'worker start/stop/restart',
  'gateway list/refresh',
  'relay tab/refresh/invites/members/search/sort/filter/create/join/disconnect/leave/join-flow/request-invite/invite/invite-accept/invite-dismiss/join-requests/approve/reject/update-members/update-auth',
  'invites refresh/accept <relay|chat>/dismiss <relay|chat>',
  'file refresh/upload/download/delete/search/sort/filter',
  'chat tab/init/refresh/create/invite/accept/dismiss/thread/send',
  'compose start/text/attach/remove/show/publish/cancel',
  'post/reply/react',
  'perf overlay/snapshot'
]

export const COMMAND_REFERENCE_SECTIONS: CommandCatalogSection[] = [
  {
    title: 'General',
    commands: [
      'help',
      'goto <dashboard|relays|relay:browse|relay:my|relay:create|chats|chats:create|invites|invites:group|invites:chat|files|files:images|files:video|files:audio|files:docs|files:other|accounts>',
      'copy selected|<field>|command [workflow]'
    ]
  },
  {
    title: 'Account',
    commands: [
      'account generate [profileName]',
      'account profiles',
      'account login <index|pubkey|label> [password]',
      'account add-nsec <nsec> [label]',
      'account add-ncryptsec <ncryptsec> <password> [label]',
      'account select <index|pubkey|label>',
      'account unlock [password]',
      'account remove <index|pubkey|label>',
      'account clear'
    ]
  },
  {
    title: 'Worker/Gateway',
    commands: [
      'worker start|stop|restart',
      'gateway list',
      'gateway refresh'
    ]
  },
  {
    title: 'Relay',
    commands: [
      'relay tab <browse|my|create|invites>',
      'relay refresh',
      'relay invites',
      'relay members [relayId]',
      'relay search <query|clear>',
      'relay sort <name|description|open|public|admin|createdAt|members|peers> [asc|desc]',
      'relay filter visibility <all|public|private>',
      'relay filter join <all|open|closed>',
      'relay create <name> --public --open',
      'relay join [publicIdentifierOrRelayKey] [token]',
      'relay disconnect <relayKey>',
      'relay leave <publicIdentifierOrRelayKey> [--archive] [--save-files]',
      'relay join-flow [publicIdentifier] [token]',
      'relay request-invite [relayId] [code] [reason]',
      'relay invite [relayId] [relayUrl] <inviteePubkey> [token]',
      'relay invite-accept [inviteId]',
      'relay invite-dismiss [inviteId]',
      'relay join-requests [relayId]',
      'relay approve [relayId] <pubkey>',
      'relay reject [relayId] <pubkey>',
      'relay update-members [relayKeyOrIdentifier] add|remove <pubkey>',
      'relay update-auth [relayKeyOrIdentifier] <pubkey> <token>'
    ]
  },
  {
    title: 'Invites',
    commands: [
      'invites refresh',
      'invites accept <relay|chat> [inviteId]',
      'invites dismiss <relay|chat> [inviteId]'
    ]
  },
  {
    title: 'Posts',
    commands: [
      'post <content>',
      'reply <eventId> <eventPubkey> <content>',
      'react <eventId> <eventPubkey> <reaction>'
    ]
  },
  {
    title: 'Files',
    commands: [
      'file refresh [groupId]',
      'file upload <groupIdOrRelayKey> <absolutePath>',
      'file download [eventId|sha256]',
      'file delete [eventId|sha256]'
    ]
  },
  {
    title: 'Chat',
    commands: [
      'chat init|refresh',
      'chat create <title> <pubkey1,pubkey2,...> [description]',
      'chat invite [conversationId] <pubkey1,pubkey2,...>',
      'chat accept [inviteId]',
      'chat dismiss [inviteId]',
      'chat thread <conversationId>',
      'chat send <conversationId> <content>'
    ]
  },
  {
    title: 'Compose/Perf',
    commands: [
      'compose start/text/attach/remove/show/publish/cancel',
      'perf overlay on|off',
      'perf snapshot'
    ]
  }
]

export function buildCommandHelpSummary(): string {
  return `Commands: ${COMMAND_HELP_GROUPS.join(' | ')}`
}

export function buildCommandReferenceLines(): string[] {
  const lines: string[] = ['Supported CLI commands']
  for (const section of COMMAND_REFERENCE_SECTIONS) {
    lines.push('')
    lines.push(`${section.title}`)
    for (const command of section.commands) {
      lines.push(`  ${command}`)
    }
  }
  return lines
}
