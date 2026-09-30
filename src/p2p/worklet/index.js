/* global Bare, BareKit */
// Bare worklet entry point (bundled by `npm run build:worklet` into src/p2p/worklet.bundle.js).
// Args: [documentsDir, configJson]. Config: { bootstrap?: string[], deviceName?: string }.

// An uncaught error in a worklet kills the whole app: install the handlers before anything else.
Bare.on('uncaughtException', (err) => {
  console.error('[huwa] uncaughtException', (err && err.stack) || err)
})
Bare.on('unhandledRejection', (err) => {
  console.error('[huwa] unhandledRejection', (err && err.stack) || err)
})

const { serve } = require('./rpc')
const { HuwaNode } = require('./node')

const log = (...args) => console.log('[huwa]', ...args)

const [documents = '.', configJson = '{}'] = Bare.argv
let config = {}
try {
  config = JSON.parse(configJson)
} catch {
  config = {}
}

const { node } = serve(
  BareKit.IPC,
  (onevent) =>
    new HuwaNode({
      storage: documents.replace(/\/$/, '') + '/huwa-p2p',
      bootstrap: Array.isArray(config.bootstrap) ? config.bootstrap : undefined,
      deviceName: typeof config.deviceName === 'string' ? config.deviceName.slice(0, 40) : 'appareil',
      onevent,
      log
    }),
  { log }
)

// iOS/Android lifecycle, driven by react-native-bare-kit from AppState.
Bare.on('suspend', () => {
  log('suspend')
  node.suspend().catch((err) => log('suspend failed', err && err.message))
})
Bare.on('resume', () => {
  log('resume')
  node.resume().catch((err) => log('resume failed', err && err.message))
})
Bare.on('idle', () => log('idle'))

log('worklet started', documents)
