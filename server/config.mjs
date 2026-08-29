import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

function optional(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function parseOrigins(value) {
  return optional(value, 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeKey(value) {
  const raw = optional(value)
  if (!raw) return null
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  try {
    const decoded = Buffer.from(raw, 'base64')
    return decoded.length === 32 ? decoded : null
  } catch {
    return null
  }
}

export function loadConfig(env = process.env) {
  const tokenEncryptionKey = normalizeKey(env.TOKEN_ENCRYPTION_KEY)
  const nodeEnv = optional(env.NODE_ENV, 'development')
  const isProduction = nodeEnv === 'production'
  const config = {
    nodeEnv,
    host: optional(env.HOST, '0.0.0.0'),
    port: Number.parseInt(optional(env.PORT, '8787'), 10) || 8787,
    appId: optional(env.QIANCHUAN_APP_ID),
    appSecret: optional(env.QIANCHUAN_APP_SECRET),
    redirectUri: optional(env.QIANCHUAN_REDIRECT_URI),
    apiBaseUrl: optional(env.QIANCHUAN_API_BASE_URL, 'https://api.oceanengine.com'),
    tokenEndpoint: optional(env.QIANCHUAN_TOKEN_ENDPOINT, 'https://ad.oceanengine.com/open_api/oauth2/access_token/'),
    refreshEndpoint: optional(env.QIANCHUAN_REFRESH_ENDPOINT, 'https://ad.oceanengine.com/open_api/oauth2/refresh_token/'),
    authorizeEndpoint: optional(env.QIANCHUAN_AUTHORIZE_ENDPOINT, 'https://ad.oceanengine.com/open_api/oauth2/authorize/'),
    tokenFile: path.resolve(optional(env.QIANCHUAN_TOKEN_FILE, path.join(serverDir, 'data', 'qianchuan-token.enc'))),
    stateFile: path.resolve(optional(env.QIANCHUAN_STATE_FILE, path.join(serverDir, 'data', 'qianchuan-state.json'))),
    tokenEncryptionKey,
    clientApiKey: optional(env.QIANCHUAN_CLIENT_API_KEY),
    enableControl: optional(env.QIANCHUAN_ENABLE_CONTROL, 'false').toLowerCase() === 'true',
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    returnTo: optional(env.QIANCHUAN_RETURN_TO),
    requestLimit: Number.parseInt(optional(env.REQUEST_LIMIT, '120'), 10) || 120,
  }
  const missing = []
  if (!config.appId) missing.push('QIANCHUAN_APP_ID')
  if (!config.redirectUri) missing.push('QIANCHUAN_REDIRECT_URI')
  if (isProduction && !config.appSecret) missing.push('QIANCHUAN_APP_SECRET')
  if (isProduction && !config.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY')
  if (isProduction && !config.clientApiKey) missing.push('QIANCHUAN_CLIENT_API_KEY')
  return { ...config, missing, isProduction }
}

export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('hex')
}
