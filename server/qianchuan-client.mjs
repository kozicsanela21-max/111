const DEFAULT_TIMEOUT_MS = 12000

function asRecord(value) {
  return value && typeof value === 'object' ? value : {}
}

function apiData(payload) {
  const record = asRecord(payload)
  if (record.code !== undefined && Number(record.code) !== 0) {
    throw new Error(`千川 API 返回错误 code=${String(record.code)}`)
  }
  return record.data ?? record
}

async function responseJson(response) {
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`千川 API 返回非 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`千川 API HTTP ${response.status}`)
  return apiData(payload)
}

export class QianchuanClient {
  constructor({ config, tokenStore, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.config = config
    this.tokenStore = tokenStore
    this.fetchImpl = fetchImpl
    this.now = now
    this.token = null
  }

  async init() {
    this.token = await this.tokenStore.load()
    return this.token
  }

  hasToken() {
    return Boolean(this.token?.access_token)
  }

  tokenExpiresAt() {
    return this.token?.expires_at || null
  }

  async request(url, init = {}, { accessToken = true } = {}) {
    const headers = new Headers(init.headers || {})
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (accessToken) {
      if (!this.token?.access_token) throw new Error('尚未完成千川 OAuth 授权')
      headers.set('Access-Token', this.token.access_token)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      return await this.fetchImpl(url, { ...init, headers, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async exchangeAuthorizationCode(authCode) {
    const response = await this.request(this.config.tokenEndpoint, {
      method: 'POST',
      body: JSON.stringify({ app_id: this.config.appId, secret: this.config.appSecret, auth_code: authCode }),
    }, { accessToken: false })
    const data = await responseJson(response)
    return this.saveToken(data)
  }

  async refreshAccessToken() {
    if (!this.token?.refresh_token) throw new Error('没有可刷新的 Refresh Token')
    const response = await this.request(this.config.refreshEndpoint, {
      method: 'POST',
      body: JSON.stringify({ app_id: this.config.appId, secret: this.config.appSecret, refresh_token: this.token.refresh_token }),
    }, { accessToken: false })
    const data = await responseJson(response)
    return this.saveToken(data)
  }

  async ensureFreshToken() {
    if (!this.hasToken()) return false
    const expiresAt = Date.parse(this.token.expires_at || '')
    if (Number.isFinite(expiresAt) && expiresAt - this.now() > 120000) return true
    try {
      await this.refreshAccessToken()
      return true
    } catch {
      return false
    }
  }

  async saveToken(data) {
    const accessToken = data.access_token || data.accessToken
    const refreshToken = data.refresh_token || data.refreshToken
    if (!accessToken || !refreshToken) throw new Error('OAuth 响应缺少 access_token 或 refresh_token')
    const expiresIn = Number(data.expires_in || data.access_token_expires_in || 86400)
    const refreshExpiresIn = Number(data.refresh_token_expires_in || 30 * 86400)
    this.token = {
      access_token: String(accessToken),
      refresh_token: String(refreshToken),
      expires_at: new Date(this.now() + expiresIn * 1000).toISOString(),
      refresh_expires_at: new Date(this.now() + refreshExpiresIn * 1000).toISOString(),
      saved_at: new Date(this.now()).toISOString(),
    }
    await this.tokenStore.save(this.token)
    return this.token
  }

  async listAdvertisers() {
    await this.ensureFreshToken()
    const url = new URL('/open_api/v1.0/qianchuan/shop/advertiser/list/', this.config.apiBaseUrl)
    url.searchParams.set('app_id', this.config.appId)
    return responseJson(await this.request(url))
  }

  async listPromotions(advertiserId) {
    await this.ensureFreshToken()
    const url = new URL('/open_api/v1.0/qianchuan/uni_promotion/list/', this.config.apiBaseUrl)
    url.searchParams.set('app_id', this.config.appId)
    url.searchParams.set('advertiser_id', advertiserId)
    url.searchParams.set('page', '1')
    url.searchParams.set('page_size', '100')
    return responseJson(await this.request(url))
  }

  async healthProbe() {
    if (!this.config.appId || !this.config.appSecret || !this.config.tokenEncryptionKey) return { state: 'permission_review', advertisers: [], message: '服务端缺少 App ID、App Secret 或 Token 加密密钥。' }
    if (!this.hasToken()) return { state: 'authorization_required', advertisers: [], message: '等待店铺管理员完成 OAuth 授权。' }
    try {
      const data = await this.listAdvertisers()
      const list = Array.isArray(data) ? data : data.list || data.advertisers || data.items || []
      const advertisers = list.map((item) => String(item.advertiser_id || item.advertiserId || item.id || '')).filter(Boolean)
      return { state: 'connected', advertisers, message: advertisers.length ? 'OAuth、Token 和千川账户关系接口检查通过。' : 'Token 有效，但暂未发现关联投放账户。' }
    } catch (error) {
      return { state: 'authorization_required', advertisers: [], message: error instanceof Error ? error.message : '千川账户检查失败。' }
    }
  }

  async control({ advertiserId, adId, action, value, duration, objective, materialId }) {
    await this.ensureFreshToken()
    const base = { advertiser_id: advertiserId, ad_id: adId }
    let pathname = '/open_api/v1.0/qianchuan/uni_promotion/ad/status/update/'
    let body = { ...base, status: action === 'pause' ? 'DISABLE' : 'ENABLE' }
    if (action === 'budget') {
      pathname = '/open_api/v1.0/qianchuan/uni_promotion/ad/budget/update/'
      body = { ...base, budget: value }
    } else if (action === 'roi') {
      pathname = '/open_api/v1.0/qianchuan/uni_promotion/ad/roi2_goal/update/'
      body = { ...base, roi2_goal: value }
    } else if (action === 'quickBoost' || action === 'materialBoost') {
      pathname = '/open_api/v1.0/qianchuan/uni_promotion/ad/control_task/create/'
      body = {
        ...base,
        scene: action === 'quickBoost' ? 'SMART_BOOST' : 'MATERIAL_ADD_BUDGET',
        budget: value,
        duration,
        objective: objective === 'popularity' ? 'LIVE_ROOM_POPULARITY' : 'LIVE_ROOM_PURCHASE',
        material_ids: materialId ? [materialId] : undefined,
      }
    }
    const url = new URL(pathname, this.config.apiBaseUrl)
    url.searchParams.set('app_id', this.config.appId)
    const data = await responseJson(await this.request(url, { method: 'POST', body: JSON.stringify(body) }))
    return { requestId: String(data.request_id || data.requestId || data.task_id || `QC-${Date.now()}`), data }
  }
}
