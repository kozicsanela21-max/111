# 千川服务端代理

这个服务负责 OAuth 授权码交换、Token 加密保存、Token 刷新、千川账户健康检查和调控请求转发。浏览器和桌面软件都不能直接持有 App Secret、Access Token 或 Refresh Token。

## 本地运行

```powershell
Copy-Item server/.env.example server/.env
# 用真实环境变量覆盖 server/.env 中的空值
$env:QIANCHUAN_APP_SECRET = '只在本机进程环境中设置'
$env:TOKEN_ENCRYPTION_KEY = (node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
$env:QIANCHUAN_CLIENT_API_KEY = (node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")
node server/index.mjs
```

健康检查：`GET /health`  ；OAuth 入口：`GET /api/qianchuan/oauth/start`。

## 部署

将 `server` 目录作为长运行 Node 服务部署到 Railway、Render、Fly.io 或自有云主机，再绑定你拥有的域名和 HTTPS。需要持久化 `server/data`，否则重启后会丢失加密 Token 和 OAuth state。

生产环境必须配置：`QIANCHUAN_APP_ID`、`QIANCHUAN_APP_SECRET`、`QIANCHUAN_REDIRECT_URI`、`TOKEN_ENCRYPTION_KEY`、`QIANCHUAN_CLIENT_API_KEY` 和 `ALLOWED_ORIGINS`。真实调控还需在确认计划回读正确后显式设置 `QIANCHUAN_ENABLE_CONTROL=true`，默认保持关闭。

`QIANCHUAN_CLIENT_API_KEY` 是软件访问代理的独立密钥，不要与千川 Token 混用。`/health` 可公开读取有限状态，`/api/qianchuan/control` 与 `/api/qianchuan/dashboard` 必须带 `X-Qianchuan-Client-Key` 或 Bearer 密钥。

## 真实数据适配说明

OAuth、账户发现和真实计划列表已经接入官方接口契约。商品卡/直播的完整报表指标和 data_topic 仍需要根据你应用实际获批的权限，先调用官方 `config/get` 后做字段映射；计划列表中未返回的指标会显示为 0，不会用模拟数值冒充真实数据。
