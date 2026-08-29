import { createQianchuanHttpApp } from './http-app.mjs'

const app = createQianchuanHttpApp()
await app.ready
app.server.listen(app.config.port, app.config.host, () => {
  console.log(`Qianchuan proxy listening on http://${app.config.host}:${app.config.port}`)
  if (app.config.missing.length) console.warn(`Missing configuration: ${app.config.missing.join(', ')}`)
})

function shutdown() {
  app.server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
