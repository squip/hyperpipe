# First-Party Reference Plugins

This directory contains installable first-party plugin examples used by the Plugin Manager reference catalog.

Included plugins:

- `hello-nav-page`: minimal additive nav + route plugin.
- `p2p-audio-room`: host media + p2p session/signal control panel.
- `threejs-multiplayer-demo`: Three.js route that uses host p2p signaling for multiplayer-style updates.

## Build archives

From repository root:

```bash
node /Users/essorensen/hyperpipe/hyperpipe-bridge/plugins/reference/build-reference-plugins.mjs
```

Archives will be written under:

- `hyperpipe-bridge/plugins/reference/dist/*.htplugin.tgz`

Plugin Manager can also build/install these directly via the in-app first-party section.
