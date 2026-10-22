# aaswitch-hub

aaswitch 账号与设备中枢服务（ToDesk 模式）。桌面端 daemon 登录 aaswitch 账号后，把设备（含 relay
配对凭据）登记到 hub；小程序端登录同一账号即可看到设备列表，点击即连。

hub 只做**发现/牵线**：存储账号、设备登记信息和 relay offer（`serverId` + daemon 公钥 +
endpoint）。端到端加密（E2EE）仍在 daemon 与客户端之间完成，relay 只转发密文——hub 永远见不到
加密内容。

当前部署域名：`remoteagent.agentsworkforyou.cn`（后续迁移至 aaswitch 域名）。

## 技术形态

- 纯 `node:http` + 内置 `node:crypto`，**零运行时依赖**；TypeScript，Node ≥ 20。
- 密码 scrypt（N=16384, r=8, p=1，16 字节盐，编码为
  `scrypt$N$r$p$keylen$saltB64$hashB64` 存单字段）。
- Bearer token 形如 `<sessionId>.<key>`：服务端只存 `HMAC-SHA256(HUB_TOKEN_SECRET, key)`
  的十六进制摘要，数据库泄露也无法还原可用 token；session 可随时吊销（登出即删行）。
- JSON 文件存储 + 原子写（tmp + fsync + rename），文件权限 0600。
- 结构化 JSON 日志（stdout，每行一个 JSON 对象），不记录 token、密码、offer。

## 构建与运行

```bash
cd hub
npm install
npm run build          # tsc -> dist/
npm test               # vitest
node dist/server.js    # 启动，默认 0.0.0.0:6780
```

### 环境变量

| 变量                 | 默认              | 说明                                                                     |
| -------------------- | ----------------- | ------------------------------------------------------------------------ |
| `HUB_HOST`           | `0.0.0.0`         | 监听地址                                                                 |
| `HUB_PORT`           | `6780`            | 监听端口                                                                 |
| `HUB_DB_PATH`        | `./data/hub.json` | JSON 存储路径（目录自动创建，0700；文件 0600）                           |
| `HUB_TOKEN_SECRET`   | 自动生成          | token HMAC 密钥；未设置时首次随机生成并持久化到 `<db>.secret`（0600）    |
| `HUB_TOKEN_TTL_DAYS` | `30`              | 登录 token 有效期（天）                                                  |
| `HUB_ONLINE_TTL_MS`  | `60000`           | 设备在线判定窗口（毫秒）                                                 |
| `HUB_TRUST_PROXY`    | `false`           | 信任一层反代的 `X-Forwarded-For`（nginx 后面必须开，否则全站共享限速桶） |
| `HUB_LOG_LEVEL`      | `info`            | `debug` / `info` / `warn` / `error`                                      |

## HTTP API

统一 `POST /api/<method>` + JSON body，方法名点分命名（如 `POST /api/auth.login`）；响应包络
`{ok:true,data}` 或 `{ok:false,error:{code,message}}`。鉴权方式：`Authorization: Bearer <token>`。
`GET /health` 返回 `{"status":"ok"}`（不走包络）。直连 hub 与经 nginx 反代使用**完全相同**的 URL
形状（nginx 原样透传 `/api/` 前缀，不做 strip）。

### auth.\*

| 方法            | 鉴权   | 请求                   | 成功 data                                                              | 失败码                                                                |
| --------------- | ------ | ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `auth.register` | 无     | `{username, password}` | `{account:{id, username, createdAt}}`                                  | 400 `bad_request`、409 `auth.username_taken`、429 `rate_limited`      |
| `auth.login`    | 无     | `{username, password}` | `{token, account:{id, username, createdAt}}`（token 有效期默认 30 天） | 401 `auth.invalid_credentials`、400 `bad_request`、429 `rate_limited` |
| `auth.logout`   | Bearer | `{}`                   | `{ok:true}`（吊销当前 token）                                          | 401 `auth.token_invalid`                                              |
| `auth.me`       | Bearer | `{}`                   | `{account:{id, username, createdAt}}`                                  | 401 `auth.token_invalid`                                              |

- username：3–32 位，`/^[a-z0-9_-]+$/`；password：8–1024 位。
- `auth.login` 对"用户不存在"与"密码错误"返回同一错误，避免用户名探测。
- `auth.register` / `auth.login` 每 IP 限速 10 次/分钟（429 + `Retry-After` 头）。

### devices.\*

全部需要 Bearer。`offer` 为 daemon relay 配对凭据的扁平化结构（来自 ConnectionOfferV2）：

```
offer: {
  serverId: string          // 非空，daemon 稳定标识（srv_<base64url>），兼作 relay 会话 id
  daemonPublicKeyB64: string // base64（含 base64url 变体），必须解码为 32 字节 libsodium box 公钥
  endpoint: string          // host:port，端口 1-65535；IPv6 写 [::1]:443
  useTls?: boolean          // 可选
}
```

| 方法                 | 请求                        | 成功 data                                                                                   | 失败码                                                              |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `devices.register`   | `{name, os, agent?, offer}` | `{deviceId, updated}`（updated=true 表示同名更新）                                          | 400 `bad_request`/`devices.offer_invalid`、401 `auth.token_invalid` |
| `devices.heartbeat`  | `{deviceId, offer?}`        | `{ok:true}`（刷新 lastSeenAt；offer 可选覆盖）                                              | 401、404 `not_found`、400 `devices.offer_invalid`                   |
| `devices.unregister` | `{deviceId}`                | `{ok:true}`                                                                                 | 401、404 `not_found`                                                |
| `devices.list`       | `{}`                        | `{devices:[{deviceId, name, os, agent?, offer, online, lastSeenAt, createdAt, updatedAt}]}` | 401                                                                 |

- **注册幂等**：同账号下 `name` 唯一；同名重复注册 = 原地更新并返回原 `deviceId`，daemon
  重启后重注册无副作用。
- **心跳建议间隔 20s**；`online` = `lastSeenAt` 距今在 `HUB_ONLINE_TTL_MS`（默认 60s）内。
- `agent` 可选（如 `claude-code`），≤64 字符；`name` ≤128、`os` ≤64。
- 设备操作只作用于本人账号下的设备；他人的 deviceId 返回 404（不泄露存在性）。

### 错误码 → HTTP 状态

| code                       | status |
| -------------------------- | ------ |
| `bad_request`              | 400    |
| `devices.offer_invalid`    | 400    |
| `auth.token_invalid`       | 401    |
| `auth.invalid_credentials` | 401    |
| `not_found`                | 404    |
| `auth.username_taken`      | 409    |
| `rate_limited`             | 429    |
| `method_not_allowed`       | 405    |
| `internal_error`           | 500    |

### curl 冒烟

```bash
curl -s http://127.0.0.1:6780/api/auth.register -d '{"username":"alice","password":"hunter2secret"}'
# {"ok":true,"data":{"account":{"id":"acc_...","username":"alice","createdAt":"..."}}}
TOKEN=$(curl -s http://127.0.0.1:6780/api/auth.login -d '{"username":"alice","password":"..."}' | jq -r .data.token)
curl -s http://127.0.0.1:6780/api/devices.register -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"mac-studio","os":"darwin","offer":{"serverId":"srv_x","daemonPublicKeyB64":"<43字符base64>","endpoint":"relay.example.com:443","useTls":true}}'
curl -s http://127.0.0.1:6780/api/devices.list -H "Authorization: Bearer $TOKEN"
```

## 威胁模型

hub 被攻破（数据库文件泄露）时，攻击者获得：

- 账号记录：username + scrypt 哈希（不可逆推密码，但可离线暴力破解弱密码）。
- session 行：只有 HMAC 摘要，无法还原 token。
- **设备 relay offer（serverId + daemon 公钥 + endpoint）**：攻击者可以**向 daemon 发起
  E2EE 连接请求**。daemon 侧的配对/授权确认是唯一防线。

缓解（后续任务实现，本版未实现）：首次连接时 daemon 弹出配对确认码（短号比对），未确认的
连接请求一律拒绝。届时"知道 offer"只等于"能敲门"，不等于"能进门"。

其他边界：

- hub 与客户端之间走 HTTPS（由 nginx 终结）；hub 自身监听 HTTP，只应绑定 `127.0.0.1` 或内网。
- 限速为进程内存态，重启即清零；hub 是单实例服务，无跨实例协调需求。
- 不存在账号删除 / 改密 / 设备枚举（跨账号）接口；`devices.list` 只返回本人设备。

## 部署

### systemd

`/etc/systemd/system/aaswitch-hub.service`：

```ini
[Unit]
Description=aaswitch-hub (account & device discovery)
After=network.target

[Service]
Type=simple
User=aaswitch
WorkingDirectory=/opt/aaswitch/hub
Environment=HUB_HOST=127.0.0.1
Environment=HUB_PORT=6780
Environment=HUB_TRUST_PROXY=1
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=2
# 加固
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/aaswitch/hub/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now aaswitch-hub
```

### nginx（`/api/` 前缀原样透传）

```nginx
server {
  listen 443 ssl http2;
  server_name remoteagent.agentsworkforyou.cn;
  # ssl_certificate ...; ssl_certificate_key ...;

  location /api/ {
    proxy_pass http://127.0.0.1:6780;    # 无 URI 部分 = 不改写路径，/api/ 前缀原样透传
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
  }

  location /health {
    proxy_pass http://127.0.0.1:6780/health;
  }
}
```

客户端统一请求 `https://<域名>/api/<method>`（如 `/api/auth.login`），直连 hub（如内网
`http://127.0.0.1:6780/api/auth.login`）与公网反代 URL 形状完全一致。反代后必须设置
`HUB_TRUST_PROXY=1`，否则所有请求的 IP 都是 127.0.0.1，登录限速会全局共享。

## 存储

单个 JSON 文件（默认 `data/hub.json`，2 空格缩进，可直接人工检视）：

```json
{
  "version": 1,
  "accounts": [
    { "id": "acc_...", "username": "...", "passwordHash": "scrypt$...", "createdAt": "..." }
  ],
  "sessions": [
    { "id": "...", "keyHash": "...", "accountId": "...", "createdAt": "...", "expiresAt": "..." }
  ],
  "devices": [
    {
      "deviceId": "dev_...",
      "accountId": "...",
      "name": "...",
      "os": "...",
      "agent": "...",
      "offer": {
        "serverId": "...",
        "daemonPublicKeyB64": "...",
        "endpoint": "...",
        "useTls": true
      },
      "createdAt": "...",
      "updatedAt": "...",
      "lastSeenAt": "..."
    }
  ]
}
```

写入路径：内存态同步变更 → tmp 文件（同目录、0600）→ fsync → rename。过期 session 在启动加载、
鉴权命中和每 10 分钟定时三个时机清扫。无迁移框架；`version` 字段预留给破坏性变更。
