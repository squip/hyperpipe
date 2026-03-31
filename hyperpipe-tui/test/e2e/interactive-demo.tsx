import React from 'react'
import { render } from 'ink'
import type { RuntimeOptions } from '../../src/domain/controller.js'
import { App, type ScriptedCommand } from '../../src/ui/App.js'
import { MockController } from './support/mockController.js'

const stayOpen = process.argv.includes('--stay-open')
const noAnimations = process.argv.includes('--no-animations')

const options: RuntimeOptions = {
  cwd: process.cwd(),
  storageDir: '/tmp/hyperpipe-tui-e2e-demo',
  noAnimations,
  logLevel: 'info'
}

const commands: ScriptedCommand[] = [
  { command: 'account profiles', delayMs: 500 },
  { command: 'account generate walkthrough_profile' },
  { command: 'account profiles' },
  { command: 'account login walkthrough_profile' },

  { command: 'relay refresh', delayMs: 900 },
  { command: 'relay create walkthrough --public --open --desc scripted_demo_group' },
  { command: 'relay refresh' },
  { command: 'copy selected' },
  { command: 'copy command' },
  { command: `relay update-members add ${'c'.repeat(64)}` },
  { command: `relay update-auth ${'c'.repeat(64)} token-auth-demo` },
  { command: 'goto invites:group' },
  { command: `relay invite ${'b'.repeat(64)} token-demo` },
  { command: 'relay join-flow token-join --open' },
  { command: 'relay join npubdemo:group token-join' },

  { command: 'post scripted walkthrough post from the terminal app' },
  { command: 'relay tab my' },

  { command: 'file refresh npubseed:group-a' },
  { command: 'file upload npubseed:group-a /tmp/demo-upload.txt' },
  { command: 'file download c2bb3ccfff6a5dec63bfc98b37438bd1cbf44fb16376761c797302e8392207aa' },
  { command: 'file delete c2bb3ccfff6a5dec63bfc98b37438bd1cbf44fb16376761c797302e8392207aa' },

  { command: 'chat init' },
  { command: 'chat create DemoChat aaaaaaaa,bbbbbbbb' },
  { command: 'chat accept chat-invite-1' },
  { command: 'chat thread conv-seed-1' },
  { command: 'chat send conv-seed-1 scripted chat message from walkthrough' },

  { command: 'relay leave npubdemo:group --archive --save-files' },
  { command: 'goto logs' }
]

render(
  <App
    options={options}
    controllerFactory={(runtimeOptions) => MockController.withSeedData(runtimeOptions)}
    scriptedCommands={commands}
    autoExitOnScriptComplete={!stayOpen}
  />
)
