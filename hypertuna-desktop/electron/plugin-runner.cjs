const path = require('path');
const { pathToFileURL } = require('url');
const { existsSync } = require('fs');

let pluginModule = null;
let activateContext = null;

function sendToHost(message) {
  if (typeof process.send !== 'function') return;
  try {
    process.send(message);
  } catch (_) {}
}

function safeErrorMessage(error) {
  if (!error) return 'Unknown plugin runner error';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

async function loadPluginModule() {
  const entryPath = process.env.PLUGIN_ENTRYPOINT_PATH;
  if (!entryPath || !existsSync(entryPath)) {
    sendToHost({
      type: 'plugin-runner-status',
      phase: 'ready',
      hasEntrypoint: false
    });
    return;
  }

  try {
    const moduleUrl = pathToFileURL(entryPath).href;
    pluginModule = await import(moduleUrl);

    activateContext = {
      pluginId: process.env.PLUGIN_ID || null,
      pluginVersion: process.env.PLUGIN_VERSION || null,
      emit(eventType, payload = {}) {
        sendToHost({
          type: 'plugin-event',
          eventType,
          payload
        });
      }
    };

    if (typeof pluginModule.activate === 'function') {
      await pluginModule.activate(activateContext);
    }

    sendToHost({
      type: 'plugin-runner-status',
      phase: 'ready',
      hasEntrypoint: true
    });
  } catch (error) {
    sendToHost({
      type: 'plugin-runner-status',
      phase: 'failed',
      error: safeErrorMessage(error)
    });
  }
}

async function handleInvoke(message) {
  if (!pluginModule || typeof pluginModule.handleInvoke !== 'function') {
    sendToHost({
      type: 'plugin-runner-response',
      requestId: message.requestId,
      success: false,
      error: 'Plugin does not export handleInvoke()'
    });
    return;
  }

  try {
    const result = await pluginModule.handleInvoke(message.payload || {}, activateContext);
    sendToHost({
      type: 'plugin-runner-response',
      requestId: message.requestId,
      success: true,
      data: result ?? null
    });
  } catch (error) {
    sendToHost({
      type: 'plugin-runner-response',
      requestId: message.requestId,
      success: false,
      error: safeErrorMessage(error)
    });
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'plugin-runner-invoke') {
    handleInvoke(message).catch((error) => {
      sendToHost({
        type: 'plugin-runner-response',
        requestId: message.requestId || null,
        success: false,
        error: safeErrorMessage(error)
      });
    });
    return;
  }

  if (message.type === 'plugin-runner-stop') {
    Promise.resolve()
      .then(async () => {
        if (pluginModule && typeof pluginModule.deactivate === 'function') {
          await pluginModule.deactivate(activateContext);
        }
      })
      .finally(() => process.exit(0));
  }
});

loadPluginModule().catch((error) => {
  sendToHost({
    type: 'plugin-runner-status',
    phase: 'failed',
    error: safeErrorMessage(error)
  });
});

process.on('uncaughtException', (error) => {
  sendToHost({
    type: 'plugin-runner-status',
    phase: 'crashed',
    error: safeErrorMessage(error)
  });
});

process.on('unhandledRejection', (reason) => {
  sendToHost({
    type: 'plugin-runner-status',
    phase: 'crashed',
    error: safeErrorMessage(reason)
  });
});
