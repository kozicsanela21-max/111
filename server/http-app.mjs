import crypto from 'node:crypto'
import http from 'node:http'
import { URL } from 'node:url'
import { loadConfig } from './config.mjs'
import { EncryptedTokenStore } from './token-store.mjs'
import { StateStore } from './state-store.mjs'
import { QianchuanClient } from './qianchuan-client.mjs'

const STATE_TTL_MS = 10 * 60 * 1000
function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders })
  response.end(body)
}

function html(response, status, title, message) {
  const safe = String(message).replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]))
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${safe}</p></body></html>`
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

function clientKeyAuthorized(request, config) {
  if (!config.clientApiKey) return config.nodeEnv !== 'production'
  return request.headers['x-qianchuan-client-key'] === config.clientApiKey || request.headers.authorization === `Bearer ${config.clientApiKey}`
}

function originHeaders(request, config) {
  const origin = request.headers.origin
  if (!origin || config.allowedOrigins.includes('*')) return { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Credentials': 'true' }
  return config.allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {}
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求体必须是 JSON') }
}

function capabilities(probe, config) {
  const connected = probe.state === 'connected'
  const authReady = connected || probe.state === 'authorization_required'
  const dataReady = connected && probe.dataReady
  return [
    { key: 'developer_app', label: '企业开发者应用', state: config.appId && config.appSecret ? 'ready' : 'pending', detail: config.appId && config.appSecret ? '服务端已读取应用配置' : '缺少服务端应用配置' },
    { key: 'oauth', label: 'OAuth 2.0 授权', state: connected ? 'ready' : authReady ? 'pending' : 'blocked', detail: connected ? 'Token 有效且可刷新' : probe.message },
    { key: 'account_discovery', label: '店铺与投放账户', state: connected ? 'ready' : 'blocked', detail: connected ? `已发现 ${probe.advertisers.length} 个投放账户` : '等待授权后读取 advertiser_id', permission: '20121100' },
    { key: 'product_reports', label: '商品卡计划数据', state: dataReady ? 'ready' : 'blocked', detail: dataReady ? '真实计划列表回读成功' : '等待真实计划列表回读', permission: '22100600' },
    { key: 'live_reports', label: '直播间数据', state: dataReady ? 'pending' : 'blocked', detail: dataReady ? '计划已读取，直播分钟报表仍需按账户字段配置' : '需要有效 Token 与数据权限', permission: '22100400' },
    { key: 'control_api', label: '预算 / ROI / 调控', state: dataReady && config.enableControl ? 'ready' : 'blocked', detail: dataReady && config.enableControl ? '已显式开启真实调控，提交后仍需回读' : '默认关闭写权限，避免演示计划误操作', permission: '21010000 / 200000037' },
    { key: 'realtime_events', label: '实时变更推送', state: config.redirectUri?.startsWith('https://') ? 'pending' : 'blocked', detail: config.redirectUri?.startsWith('https://') ? '需要在平台后台完成 SPI 验签配置' : '需要公网 HTTPS 回调', },
  ]
}

export function createQianchuanHttpApp({ env = process.env, fetchImpl, tokenStore, stateStore } = {}) {
  const config = loadConfig(env)
  const store = tokenStore || new EncryptedTokenStore({ filePath: config.tokenFile, key: config.tokenEncryptionKey })
  const states = stateStore || new StateStore(config.stateFile)
  const client = new QianchuanClient({ config, tokenStore: store, fetchImpl })
  const rate = new Map()
  let stateData = {}
  let latestDashboard = null

  const ready = (async () => {
    stateData = await states.load()
    await client.init()
  })()

  async function route(request, response) {
    await ready
    const headers = originHeaders(request, config)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...headers, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Qianchuan-Client-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' })
      response.end()
      return
    }
    const remote = request.socket.remoteAddress || 'unknown'
    const count = (rate.get(remote) || 0) + 1
    rate.set(remote, count)
    const rateTimer = setTimeout(() => rate.delete(remote), 60_000)
    rateTimer.unref?.()
    if (count > config.requestLimit) return json(response, 429, { error: '请求过于频繁，请稍后再试。' }, headers)
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok', service: 'qianchuan-proxy' }, headers)
      }

      if (request.method === 'GET' && url.pathname === '/api/qianchuan/health') {
        if (config.clientApiKey && !clientKeyAuthorized(request, config)) return json(response, 401, { error: '缺少有效的服务端访问密钥。' }, headers)
        const probe = await client.healthProbe()
        if (probe.state === 'connected') {
          try {
            latestDashboard = await buildDashboard(client, probe.advertisers)
            probe.dataReady = latestDashboard.plans.length > 0
          } catch {
            probe.dataReady = false
          }
        }
        return json(response, 200, {
          providerMode: 'live_proxy',
          appId: config.appId,
          state: probe.state,
          statusLabel: probe.state === 'connected' ? '已连接' : probe.state === 'authorization_required' ? '需要授权' : '待配置',
          accountLabel: probe.advertisers.length ? `已连接 ${probe.advertisers.length} 个投放账户` : '未确认真实账户',
          advertiserIds: probe.advertisers,
          lastCheckedAt: new Date().toISOString(),
          tokenExpiresAt: client.tokenExpiresAt(),
          canReadData: Boolean(probe.dataReady),
          canControl: Boolean(probe.dataReady && config.enableControl),
          capabilities: capabilities(probe, config),
          message: probe.message,
        }, headers)
      }

      if (request.method === 'GET' && url.pathname === '/api/qianchuan/oauth/start') {
        if (!config.appId || !config.redirectUri) return json(response, 503, { error: '服务端尚未配置 App ID 或回调地址。' }, headers)
        const state = crypto.randomBytes(24).toString('hex')
        stateData[state] = { createdAt: Date.now(), returnTo: config.returnTo || '' }
        await states.save(stateData)
        const authorize = new URL(config.authorizeEndpoint)
        authorize.searchParams.set('app_id', config.appId)
        authorize.searchParams.set('redirect_uri', config.redirectUri)
        authorize.searchParams.set('state', state)
        return response.writeHead(302, { Location: authorize.toString(), 'Set-Cookie': `qc_oauth_state=${encodeURIComponent(state)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`, ...headers }).end()
      }

      if (url.pathname === '/api/qianchuan/oauth/callback' && request.method === 'GET') {
        const authCode = url.searchParams.get('auth_code') || url.searchParams.get('code')
        const state = url.searchParams.get('state') || ''
        const pending = stateData[state]
        if (!authCode || !pending || Date.now() - pending.createdAt > STATE_TTL_MS) return html(response, 400, '授权未完成', '授权码缺失、state 无效或已过期，请返回软件重新发起授权。')
        delete stateData[state]
        await states.save(stateData)
        try {
          await client.exchangeAuthorizationCode(authCode)
          const returnTo = pending.returnTo
          if (returnTo && /^https:\/\//i.test(returnTo)) return response.writeHead(302, { Location: returnTo, 'Set-Cookie': 'qc_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', ...headers }).end()
          return html(response, 200, '授权成功', '授权已完成，现可关闭此页面并返回软件。')
        } catch (error) {
          return html(response, 502, '授权交换失败', error instanceof Error ? error.message : '服务端无法完成 Token 交换。')
        }
      }

      if (url.pathname === '/api/qianchuan/oauth/callback' && request.method === 'POST') {
        const body = await readBody(request)
        const state = typeof body.state === 'string' ? body.state : ''
        const pending = stateData[state]
        if (!body.auth_code || !state || !pending || Date.now() - pending.createdAt > STATE_TTL_MS) return json(response, 400, { error: 'auth_code 或 state 无效。' }, headers)
        delete stateData[state]
        await states.save(stateData)
        await client.exchangeAuthorizationCode(String(body.auth_code))
        return json(response, 200, { ok: true, message: '授权码已换取并加密保存 Token。' }, headers)
      }

      if (url.pathname === '/api/qianchuan/control' && request.method === 'POST') {
        if (!clientKeyAuthorized(request, config)) return json(response, 401, { error: '缺少有效的服务端访问密钥。' }, headers)
        const body = await readBody(request)
        if (!config.enableControl) return json(response, 403, { error: '服务端真实调控开关未开启。' }, headers)
        if (!body.advertiserId || !body.adId || !['pause', 'resume', 'budget', 'roi', 'quickBoost', 'materialBoost'].includes(body.action)) return json(response, 400, { error: '调控请求缺少合法的 advertiserId、adId 或 action。' }, headers)
        const known = latestDashboard?.plans.some((plan) => plan.id === String(body.adId) && plan.advertiserId === String(body.advertiserId))
        if (!known) return json(response, 409, { error: '计划不在最近一次真实回读结果中，已阻断调控。' }, headers)
        const result = await client.control(body)
        return json(response, 200, { status: 'accepted', requestId: result.requestId, message: '请求已提交，需由服务端回读官方状态。' }, headers)
      }

      if (url.pathname === '/api/qianchuan/dashboard' && request.method === 'GET') {
        if (!clientKeyAuthorized(request, config)) return json(response, 401, { error: '缺少有效的服务端访问密钥。' }, headers)
        const probe = await client.healthProbe()
        if (probe.state !== 'connected') return json(response, 409, { error: '尚未完成千川授权。' }, headers)
        latestDashboard = await buildDashboard(client, probe.advertisers)
        return json(response, 200, latestDashboard, headers)
      }

      return json(response, 404, { error: 'Not found' }, headers)
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务端处理失败。'
      return json(response, 502, { error: message }, headers)
    }
  }

  return { config, client, route, server: http.createServer(route), ready }
}

function numeric(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function promotionList(data) {
  if (Array.isArray(data)) return data
  return data.list || data.items || data.ad_list || data.ads || []
}

function mapStatus(value) {
  const status = String(value || '').toUpperCase()
  if (status.includes('DISABLE') || status.includes('PAUSE') || status.includes('OFF')) return '已暂停'
  if (status.includes('ENABLE') || status.includes('RUN') || status.includes('DELIVERY')) return '投放中'
  return '观察中'
}

function mapPlan(raw, advertiserId) {
  const spend = numeric(raw.stat_cost ?? raw.cost ?? raw.spend)
  const gmv = numeric(raw.total_pay_order_gmv ?? raw.total_pay_amount ?? raw.gmv)
  const scene = String(raw.marketing_goal ?? raw.promotion_scene ?? raw.scene ?? '').toUpperCase()
  const id = String(raw.ad_id ?? raw.project_id ?? raw.id ?? '')
  return {
    id,
    advertiserId: String(advertiserId),
    name: String(raw.name ?? raw.ad_name ?? raw.project_name ?? `千川计划 ${id}`),
    product: String(raw.product_name ?? raw.promoted_object_name ?? raw.product?.name ?? '未返回商品名称'),
    type: scene.includes('LIVE') ? '直播间' : '商品卡',
    status: mapStatus(raw.status ?? raw.opt_status ?? raw.delivery_status),
    spend,
    budget: numeric(raw.budget ?? raw.budget_amount),
    gmv,
    roi: numeric(raw.roi2 ?? raw.total_pay_roi, spend > 0 ? gmv / spend : 0),
    targetRoi: numeric(raw.roi2_goal ?? raw.roi_goal),
    ctr: numeric(raw.ctr),
    cvr: numeric(raw.pay_order_convert_rate ?? raw.cvr),
    trend: 0,
  }
}

async function buildDashboard(client, advertiserIds) {
  const batches = await Promise.all(advertiserIds.map(async (advertiserId) => {
    const data = await client.listPromotions(advertiserId)
    return promotionList(data).map((item) => mapPlan(item, advertiserId)).filter((item) => item.id)
  }))
  return { plans: batches.flat(), fetchedAt: new Date().toISOString(), source: 'qianchuan-live-proxy' }
}
