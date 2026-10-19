# Paseo 服务器机制分析与国内化替换方案（t01）

> 任务编号：t01 ｜ 分支：`docs/t01-server-domestication` ｜ 基线：`develop-xdb` @ 095dd0316

## 1. 结论速览

Paseo 的"服务器"分三类，只有 **relay 中继服务器** 是官方托管的公共服务；daemon 与连接方式本身完全自托管、无强制外部依赖。relay 端点在协议里是**数据而非硬编码常量**（默认值除外），因此替换为国内服务器**不需要改协议**，只需要：自部署一份 relay + 修改默认端点/配置。

| 类别 | 现状 | 是否依赖海外服务 | 国内化动作 |
| --- | --- | --- | --- |
| Daemon（agent 宿主） | 自托管，监听 `127.0.0.1:6767`（TCP/WebSocket/HTTP 同端口） | 否 | 无需改动；可用官方 Docker 镜像在国内 VPS/NAS 部署 |
| Relay（手机配对中继） | 托管于 `relay.paseo.sh:443`（Cloudflare Worker） | **是** | 自部署 relay（推荐纯 Node 版）+ 走 `daemon.relay.endpoint` 配置切换 |
| 插件注册表 / 桌面更新 | `paseo plugin add owner/slug` 走 GitHub 克隆；桌面更新走 GitHub Releases | 是（辅助功能） | 可选：Gitee 镜像、更新源镜像，不影响核心功能 |

## 2. 连接模型（代码事实）

- 客户端（桌面/移动/Web/CLI）连接的都是 daemon，三种传输：
  1. **直连**：`tcp://host:port`（可带 `?ssl=true`、`?password=...`），解析见 `packages/protocol/src/daemon-endpoints.ts` 的 `parseConnectionUri`。
  2. **SSH 隧道**：CLI 接受 `ssh://user@host`（远程 daemon 固定在 `127.0.0.1:6767`，可用 `?daemonPort=` 覆盖），仅密钥登录。
  3. **Relay**：`relay://endpoint/serverId?key=<daemonPublicKey>&ssl=true`，端到端加密（NaCl，`packages/relay/src/e2ee.ts`），relay 只见密文。解析见 `parseRelayConnectionUri`。
- 默认 relay 常量：`DEFAULT_RELAY_ENDPOINT = "relay.paseo.sh:443"`（`packages/protocol/src/daemon-endpoints.ts:70` 与 `packages/server/src/server/config.ts:39` 各有一份）。
- relay 实现位于 `packages/relay`：
  - Cloudflare Worker 入口 `src/cloudflare-adapter.ts` + Durable Object `RelayDurableObject`（`wrangler.toml` 绑定 `relay.paseo.sh`）。
  - `wrangler.toml` 里 `PASEO_RELAY_UPSTREAM = "https://paseo-relay-next.fly.dev"` —— 官方正在从 fly.io（纯 Node 服务）向 Cloudflare 迁移，`src/cutover-proxy.ts` 负责灰度切换。
  - 加密通道（`encrypted-channel.ts`）、密钥（`crypto.ts`，tweetnacl）与传输层解耦；包依赖里已含 `ws`，自托管纯 Node 版具备条件。

## 3. "添加服务器"的现状入口

- 桌面/移动端：Settings → Add host → Direct connection（填 host:port、SSL、密码）。
- 配对（relay）：Settings → 主机 → Pair Device，或服务器上 `paseo daemon pair`，输出二维码/深链，内嵌 `relay://...` URI —— **客户端自动从 URI 中读 endpoint**，因此服务端换哪个 relay，客户端无需单独配置。
- 服务器侧部署：`npm install -g @getpaseo/cli && paseo`（交互式引导）或 Docker（`docker/` 目录，官方镜像监听 `0.0.0.0:6767` 并内置 Web UI，`docs/docker.md`）。

## 4. 替换为国内服务器的方案

### 4.1 Daemon（agent 宿主）——零改动

- 直接在国内 VPS/Mac mini/NAS 上跑：`npm i -g @getpaseo/cli && paseo`，或 `docker compose`（见 `docker/docker-compose.example.yml`）。
- 手机在外网访问该 daemon：走下面的国内 relay，或 Tailscale/零信任直连。

### 4.2 Relay——两条自托管路线

**路线 A：Cloudflare Worker 自部署（最快，海外边缘）**
1. `cd packages/relay && npx wrangler deploy`（改 `wrangler.toml` 的 `account_id`/`routes` 为自己的域名）。
2. 优点：零运维；缺点：Cloudflare 边缘在大陆无节点，质量一般。

**路线 B：纯 Node relay 自部署（推荐，国内 VPS）**
1. 新增一个 Node 入口（`ws` WebSocketServer 实现 `RelayDurableObject` 同语义：server/client 按 `serverId` 配对、转发密文帧；协议常量 `CURRENT_RELAY_PROTOCOL_VERSION = "2"`）。加密库复用 `packages/relay/src`。
2. TLS 由 nginx/caddy 终结（wss → 本地 ws），endpoint 形如 `relay.example.cn:443`。
3. systemd 或 Docker 常驻。
4. 这是**需要开发的新任务**（预计中等工作量，协议本身只有握手/配对/转发三类消息）。

**切换配置（两种路线相同， daemon 侧生效）**
```bash
# 环境变量方式
export PASEO_RELAY_ENDPOINT="relay.example.cn:443"
export PASEO_RELAY_PUBLIC_ENDPOINT="relay.example.cn:443"   # NAT 后对外地址不同时用
export PASEO_RELAY_USE_TLS="true"

# 或持久化到 ~/.paseo/config.json
{ "daemon": { "relay": { "enabled": true, "endpoint": "relay.example.cn:443", "useTls": true } } }
```
解析逻辑见 `packages/server/src/server/config.ts` `resolveRelayConfig()`（优先级：CLI flag > env > 持久化配置 > 默认 `relay.paseo.sh:443`）。

**产品级改造（可选后续任务）**：把默认 relay 做成构建时可注入（例如 `PASEO_DEFAULT_RELAY_ENDPOINT` build 变量 + Settings 里可见的 relay 端点展示/修改项），让国产化发行版开箱即用国内 relay，无需用户手工改配置。

### 4.3 辅助服务（可选）

- 插件注册表：`owner/slug` 解析为 `https://github.com/<owner>/<repo>.git`（`packages/server/src/server/plugins/managed-source.ts`）。可选支持 Gitee 前缀（如 `gitee:owner/slug`）。
- 桌面应用更新：electron-updater 默认 GitHub Releases，国内可换 `generic` provider 指向自有静态源。

## 5. 验证方式

- `npx vitest run packages/protocol/src/daemon-endpoints.test.ts packages/protocol/src/connection-offer.test.ts`（连接/配对 URI 语义）。
- 自托管 relay 后：`paseo daemon pair` 生成 URI 应包含自部署 endpoint；手机扫码后可建立 E2EE 会话。
- relay 协议回归：`npx vitest run packages/relay`。

## 6. 与后续任务的映射

- t02–t06：五个国产 Agent provider 接入（Kimi/CodeBuddy/Qoder/Qwen/ZCode）。
- t07：zh-CN 语言覆盖审计（上游已支持 `zh-CN` 且默认跟随系统语言 `"system"`）。
- t08：全量连接验证 + 集成合并（架构师）。
