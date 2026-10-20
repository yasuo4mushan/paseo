# Paseo 微信小程序客户端（MVP）

用微信小程序监控/操控你开发机上的 Paseo AI 编码代理。代码与数据留在你的机器上：
小程序只作为远程视图，通过 **自托管 relay（端到端加密）** 或 **局域网直连** 访问 daemon。

- 框架：Taro 4 + React + TypeScript，编译目标 `weapp`。
- 本目录**不在主仓 npm workspaces 内**（自带 node_modules 与工具链，避免污染主仓依赖）。
- 协议与加密实现 vendor 自主仓 `packages/protocol` 与 `packages/relay`（来源注释见各文件头），与官方客户端/daemon 字节级互通（由测试保证）。

## 目录结构

```
miniprogram/
├── config/                  # Taro 编译配置（weapp, webpack5）
├── project.config.json      # 微信开发者工具项目配置（appid 占位 touristappid）
├── src/
│   ├── app.ts               # 入口：安装随机字节池（wx.getRandomValues → tweetnacl PRNG）
│   ├── app.config.ts        # 页面注册 + tabBar（Agent 列表 / 设置）
│   └── connection/          # 连接层（平台无关核心 + 小程序适配）
│       ├── websocket-port.ts    # 最小 SocketPort 接口（connect/send/close/onEvent）
│       ├── protocol-types.ts    # daemon 协议消息子集（vendor 自 packages/protocol）
│       ├── utf8.ts              # 纯 TS UTF-8 编解码（小程序无 TextEncoder/TextDecoder）
│       ├── random-source.ts     # tweetnacl PRNG 前置层（字节池 + 兜底）
│       ├── nacl-box.ts          # X25519 + XSalsa20-Poly1305 原语（vendor 自 packages/relay/src/crypto.ts）
│       ├── encrypted-channel.ts # E2EE 握手与信道（vendor 自 packages/relay/src/encrypted-channel.ts，客户端侧）
│       ├── relay-offer.ts       # relay:// offer 解析 / relay ws URL 构造（无 URL 类，正则实现）
│       ├── relay-transport.ts   # relay 加密 socket → E2EE 明文端口
│       ├── wx-socket.ts         # wx.connectSocket 适配（唯二依赖 Taro 的文件之一）
│       ├── daemon-connection.ts # hello 握手 + requestId 关联 RPC + 流订阅（纯逻辑，socket 注入）
│       └── connection-manager.ts# 应用态桥：storage、连接单例、状态广播（依赖 Taro）
│   └── pages/
│       ├── pair/            # 配对：粘贴 relay:// URI / wx.scanCode 扫码
│       ├── agents/          # Agent 列表：状态徽标 + 下拉刷新 + 推送更新
│       ├── agent/           # 详情：时间线消息流（订阅推送）+ 底部输入发送
│       └── settings/        # 连接状态/端点展示、断开、重连、清除配对
└── tests/                   # vitest：单元 + 官方互通 + 打真 daemon/relay 集成
```

## 与 daemon / relay 的关系

```
┌─────────────┐  wss/ws  ┌──────────────┐  转发密文  ┌──────────────┐  ws  ┌──────────┐
│ 微信小程序   │ ───────→ │ 自托管 relay  │ ────────→ │ Paseo daemon │ ←──→ │ AI agent │
│ (weapp)     │ ←─────── │ (纯转发)      │ ←──────── │ (开发机)      │      │ claude…  │
└─────────────┘          └──────────────┘           └──────────────┘      └──────────┘
     │                        relay 看不到明文              ▲
     │  X25519 + XSalsa20-Poly1305（密钥来自配对 URI 的 key 参数）│
     └────────────── E2EE（小程序 ↔ daemon）──────────────────┘

直连模式（开发/局域网）：小程序 ── ws://host:port/ws ──→ daemon（跳过 relay，无 E2EE）
```

配对流程：daemon 侧生成 relay 连接 URI（`relay://<endpoint>/<serverId>?key=<daemon公钥>`，
等同密码）→ 小程序粘贴或扫码 → 解析 offer → 连 relay `/ws?serverId=..&v=2&role=client` →
E2EE 握手（`e2ee_hello`/`e2ee_ready`）→ daemon hello → 业务 RPC。

## 开发者工具导入与运行

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)（稳定版）。
2. 依赖安装（本目录独立于主仓）：
   ```bash
   cd miniprogram
   npm install          # .npmrc 已开启 legacy-peer-deps（Taro 可选 peer 冲突）
   npm run build:weapp  # 产物输出到 miniprogram/dist
   ```
3. 打开微信开发者工具 → 导入项目 → 目录选择 `miniprogram/`（根目录，不是 dist/；
   `project.config.json` 已配置 `miniprogramRoot: "dist/"`）。AppID 选择"测试号"
   （内置 `touristappid` 游客模式即可编译预览）。
4. 开发期调试真实环境：
   - 详情 → 本地设置 → 勾选 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
     （否则 `ws://` / 明文 80 端口域名连不上）。
   - 真机预览同样需要在预览设置里打开"不校验合法域名"（仅开发版可用）。
   - 配对页粘贴 daemon 的 relay URI（或 ws://192.168.x.x:6767/ws 局域网直连）。
5. 日常开发：`npm run dev:weapp`（watch 模式，工具里自动重编译）。

## 域名白名单与上线要求（上线前必读）

开发期勾选"不校验合法域名"即可用任意 `ws://` 调试；**正式发布/体验版必须满足**：

| 事项 | 要求 |
| --- | --- |
| AppID | 在 [小程序后台](https://mp.weixin.qq.com) 注册并获得正式 AppID，替换 `project.config.json` 的 `touristappid` |
| socket 合法域名 | 后台「开发管理 → 开发设置 → 服务器域名 → socket 合法域名」添加 relay 域名，**必须是 `wss://` 协议头**（`ws://` 不允许） |
| ICP 备案 | 域名必须完成 ICP 备案（微信强制校验，未备案域名无法加入白名单） |
| TLS | wss 需要 有效证书（不能自签）；自托管 relay 若走 80 明文只能用于开发调试 |
| relay 端口 | 建议 `wss://域名:443`（或 443 映射），非常用端口也可配置但域名规则相同 |

自托管 relay 开启 TLS 的参考：域名 443 → 反向代理（Nginx/Caddy，挂 ICP 备案证书）→ relay `ws://127.0.0.1:<port>`，relay URI 用 `relay://域名:443/...?key=...&ssl=true`。

## 测试

```bash
cd miniprogram
npm run test                    # 单元 + 官方互通 + 直连 daemon 集成（daemon 离线自动 skip）
# relay 链路集成（URI 等同密码，经环境变量传入，不入库）：
PASEO_MP_TEST_RELAY_URI='relay://<host>:<port>/<serverId>?key=<urlencoded公钥>' npm run test
npm run typecheck               # src + tests 两个 tsconfig
```

- **官方互通**（`tests/e2ee-interop.test.ts`）：vendor 的客户端 E2EE 信道与主仓
  `@getpaseo/relay` 的 `createDaemonChannel`（官方 daemon 侧实现）在内存管道上握手、
  互发消息。主仓实现位置通过 `PASEO_MAIN_CHECKOUT` 环境变量或相邻检出路径探测，
  找不到时自动 skip。
- **集成**（`tests/integration-*.test.ts`）：Node `ws` 适配 + 真实 daemon
  （默认 `ws://127.0.0.1:6799`，可用 `PASEO_MP_TEST_DAEMON_URL` 覆盖）验证
  hello/server_info、agent 列表、时间线 tail、流订阅 ack。不向真实 agent 发消息
  （发送路径由单元测试覆盖，避免消耗模型配额）。

## MVP 范围与已知限制

- **仅文本 JSON 帧**：daemon 的二进制帧（终端流、文件传输）被忽略——MVP 不做终端与文件浏览。
- **无自动重连**：断线后在设置页手动重连（`onDisconnect` 已广播到页面状态）。
- **时间线仅尾部 200 条**：不做分页加载历史。
- **PRNG 兜底降级**：基础库 ≥ 2.14.0 用 `wx.getRandomValues` 字节池；更老的基础库在池空时
  退化为非加密随机（nonce 复用风险）。建议真机基础库保持新版。
- **未实现**：agent 创建/删除、权限确认（permission_requested 仅显示状态）、通知推送、
  provider 快照、多 host 配置文件（仅保存最近一次配对）。
- **主包体积**：见构建产物 `dist/`（README 下方记录实测值；微信主包上限 2MB）。

## 构建产物体积（实测 2026-10-20，Taro 4.3.0 + webpack5）

`npm run build:weapp` 后 `dist/` 全部产物 394KB（30 个文件），其中主包（app.js + vendors +
common + taro 运行时 + 4 个页面）约 375KB —— 远低于微信 2MB 主包上限，无需分包。
