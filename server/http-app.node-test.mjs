import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createQianchuanHttpApp } from './http-app.mjs'

async function withServer(fetchImpl, run) {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qianchuan-server-'))
  const app = createQianchuanHttpApp({
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      QIANCHUAN_APP_ID: '1874646807765145',
      QIANCHUAN_APP_SECRET: 'test-secret',
      QIANCHUAN_REDIRECT_URI: 'https://proxy.example.test/api/qianchuan/oauth/callback',
      QIANCHUAN_TOKEN_FILE: path.join(testDir, 'token.enc'),
      QIANCHUAN_STATE_FILE: path.join(testDir, 'state.json'),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      QIANCHUAN_CLIENT_API_KEY: 'client-test-key',
    },
    fetchImpl,
  })
  await app.ready
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ app, baseUrl })
  } finally {
    await new Promise((resolve) => app.server.close(resolve))
    await fs.rm(testDir, { recursive: true, force: true })
  }
}

test('health fails closed before OAuth authorization', async () => {
  await withServer(async () => new Response('{}', { status: 200 }), async ({ baseUrl }) => {
    const publicHealth = await fetch(`${baseUrl}/health`)
    assert.equal(publicHealth.status, 200)
    const unauthorized = await fetch(`${baseUrl}/api/qianchuan/health`)
    assert.equal(unauthorized.status, 401)
    const response = await fetch(`${baseUrl}/api/qianchuan/health`, { headers: { 'X-Qianchuan-Client-Key': 'client-test-key' } })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.appId, '1874646807765145')
    assert.equal(body.state, 'authorization_required')
    assert.equal(body.canReadData, false)
    assert.equal(body.canControl, false)
  })
})

test('OAuth callback rejects an unknown state', async () => {
  await withServer(async () => new Response('{}', { status: 200 }), async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/qianchuan/oauth/callback?auth_code=code&state=unknown`)
    assert.equal(response.status, 400)
    assert.match(await response.text(), /state/)
  })
})

test('OAuth flow stores encrypted tokens and exposes connected health', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('/access_token/')) return new Response(JSON.stringify({ data: { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, refresh_token_expires_in: 7200 } }), { status: 200 })
    if (href.includes('/shop/advertiser/list/')) return new Response(JSON.stringify({ data: { list: [{ advertiser_id: 123456 }] } }), { status: 200 })
    throw new Error(`Unexpected URL ${href}`)
  }
  await withServer(fetchImpl, async ({ app, baseUrl }) => {
    const start = await fetch(`${baseUrl}/api/qianchuan/oauth/start`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const location = new URL(start.headers.get('location'))
    const state = location.searchParams.get('state')
    const callback = await fetch(`${baseUrl}/api/qianchuan/oauth/callback?auth_code=valid-code&state=${state}`)
    assert.equal(callback.status, 200)
    const encrypted = await fs.readFile(app.config.tokenFile, 'utf8')
    assert.equal(encrypted.includes('access-secret'), false)
    const health = await (await fetch(`${baseUrl}/api/qianchuan/health`, { headers: { 'X-Qianchuan-Client-Key': 'client-test-key' } })).json()
    assert.equal(health.state, 'connected')
    assert.deepEqual(health.advertiserIds, ['123456'])
  })
})

test('control endpoint requires client authentication and an explicit server write switch', async () => {
  await withServer(async () => new Response('{}', { status: 200 }), async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/api/qianchuan/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    assert.equal(unauthorized.status, 401)
    const invalid = await fetch(`${baseUrl}/api/qianchuan/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Qianchuan-Client-Key': 'client-test-key' }, body: JSON.stringify({ action: 'pause' }) })
    assert.equal(invalid.status, 403)
  })
})
