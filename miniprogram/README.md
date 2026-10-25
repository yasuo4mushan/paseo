# aaswitch 微信小程序

**aaswitch**（based on Paseo）用微信小程序监控/操控你开发机上的 AI 编码代理，
ToDesk 式「账号 + 设备列表」：同一账号登录小程序与开发机 daemon，设备自动出现在
列表里，点在线设备即建连。代码与数据留在你的机器上：控制通道走 **自托管 relay
（端到端加密）** 或 **局域网直连**，hub/relay 只见密文。

- 框架：Taro 4 + React + TypeScript，编译目标 `weapp`。
- 本目录**不在主仓 npm workspaces 内**（自带 node_modules 与工具链，避免污染主仓依赖）。
- 协议与加密实现 vendor 自主仓 `packages/protocol` 与 `packages/relay`（来源注释见各文件头），与官方客户端/daemon 字节级互通（由测试保证）。
- UI 按微信小程序设计规范：品牌绿 #07C160、文字三阶、#F7F8FA 背景、12rpx 圆角卡片、
  8pt 栅格；`darkmode: true` + `theme.json` + `prefers-color-scheme` tokens 双主题。

## 目录结构

```
miniprogram/
├── config/                  # Taro 编译配置（weapp, webpack5; copy theme.json/tabbar 图标）
├── project.config.json      # 微信开发者工具项目配置（projectname: aaswitch）
├── scripts/
│   ├── mock-hub.mjs         # 契约级 mock hub（demo/demo123，含真实可连 relay offer）
│   ├── gen-tab-icons.mjs    # 纯 Node 生成 tabBar PNG 图标
│   └── ui-automation.mjs    # miniprogram-automator 验收脚本（截图产物见 docs/screenshots）
├── src/
│   ├── app.ts               # 入口：安装随机字节池（wx.getRandomValues → tweetnacl PRNG）
│   ├── app.config.ts        # 页面注册 + tabBar（设备/设置）+ darkmode
│   ├── theme.json           # 导航栏/tabBar 双主题变量
│   ├── app.css              # 全局 design tokens（浅/深两套，页面只引用变量）
│   ├── hub/                 # Hub HTTP 客户端：auth.* / devices.* + 会话与地址存取
│   ├── utils/time.ts        # 相对时间 / 时钟文案
│   ├── assets/tabbar/       # tabBar 图标（脚本生成，81x81）
│   ├── connection/          # 连接层（平台无关核心 + 小程序适配）
│   │   ├── websocket-port.ts    # 最小 SocketPort 接口（connect/send/close/onEvent）
│   │   ├── protocol-types.ts    # daemon 协议消息子集（vendor 自 packages/protocol）
│   │   ├── utf8.ts              # 纯 TS UTF-8 编解码（小程序无 TextEncoder/TextDecoder）
│   │   ├── random-source.ts     # tweetnacl PRNG 前置层（字节池 + 兜底）
│   │   ├── nacl-box.ts          # X25519 + XSalsa20-Poly1305 原语（vendor 自 packages/relay/src/crypto.ts）
│   │   ├── encrypted-channel.ts # E2EE 握手与信道（vendor 自 packages/relay/src/encrypted-channel.ts，客户端侧）
│   │   ├── relay-offer.ts       # relay:// offer 解析 / 构造（hub 设备 offer 与手动配对共用）
│   │   ├── relay-transport.ts   # relay 加密 socket → E2EE 明文端口
│   │   ├── wx-socket.ts         # wx.connectSocket 适配（唯二依赖 Taro 的文件之一）
│   │   ├── daemon-connection.ts # hello 握手 + requestId 关联 RPC + 流订阅（纯逻辑，socket 注入）
│   │   └── connection-manager.ts# 应用态桥：storage、连接单例、状态广播、connectOffer（hub 设备入口）
│   └── pages/
│       ├── login/           # 登录/注册（未登录首页，aaswitch 字标）
│       ├── devices/         # 设备列表（登录后主页，tab）：在线状态/心跳/点击连接
│       ├── agents/          # Agent 列表：状态徽标 + 下拉刷新 + 推送更新
│       ├── agent/           # 详情：时间线消息流（订阅推送）+ 底部输入发送
│       ├── pair/            # 手动配对（高级入口）：粘贴 relay:// URI / 扫码直连
│       └── settings/        # 账号/设备连接/Hub 服务器/高级/关于（tab）
├── docs/screenshots/        # UI 自动化验收截图（对真实 hub 生成，非设计稿）
└── tests/                   # vitest：单元 + 官方互通 + hub 客户端 mock + 集成
```

## 与 hub / daemon / relay 的关系

```
┌─────────────┐  https   ┌──────────────┐           ┌──────────────┐
│ 微信小程序   │ ───────→ │ hub          │ devices.  │ 开发机 daemon │
│ (weapp)     │ ←─────── │ (账号/设备表) │ ←register─┘ (同账号登录)  │
└──────┬──────┘          └──────────────┘ heartbeat  └──────┬───────┘
       │ 点击在线设备：devices.list 返回 offer                 │
       │  wss/ws  ┌──────────────┐  转发密文                   │
       └────────→ │ 自托管 relay  │ ─────────────────────────┘
     ←─────────── │ (纯转发)      │
       │   relay 看不到明文；X25519 + XSalsa20-Poly1305（key=daemon 公钥）
       └──────────── E2EE（小程序 ↔ daemon）───────────────┘
```

- hub（`POST <base>/<method>` JSON，`{ok:true,data}` / `{ok:false,error:{code,message}}`，
  失败伴随 401/404/409/429 状态码）：`auth.login/register/me/logout`、`devices.list`、
  `devices.register/heartbeat/unregister`。hub 地址可在设置页覆盖，默认
  `http://remoteagent.agentsworkforyou.cn/api`（正式发布必须换 https，见域名白名单）。
- 设备连接：hub 返回的 offer 与手动配对共用一条 relay:// 路径（`buildRelayUriFromOffer`
  往返一致由测试保证）；手动配对保留在 设置 → 高级。

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
     （否则 `ws://` / 明文 80 端口域名连不上；注意模拟器**禁止 ws://127.0.0.1 回环**，
     公网域名正常）。
   - 真机预览同样需要在预览设置里打开"不校验合法域名"（仅开发版可用）。
   - 用真实 hub（默认地址）注册账号即可；局域网调试可 `npm run mock:hub` 后在
     设置页把 API 地址指到 `http://<本机IP>:8788/api`（demo/demo123）。
5. 日常开发：`npm run dev:weapp`（watch 模式，工具里自动重编译）。

## 域名白名单与上线要求（上线前必读）

开发期勾选"不校验合法域名"即可用任意 `ws://` 调试；**正式发布/体验版必须满足**：

| 事项            | 要求                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AppID           | 在 [小程序后台](https://mp.weixin.qq.com) 注册并获得正式 AppID，替换 `project.config.json` 的 `touristappid`            |
| socket 合法域名 | 后台「开发管理 → 开发设置 → 服务器域名 → socket 合法域名」添加 relay 域名，**必须是 `wss://` 协议头**（`ws://` 不允许） |
| ICP 备案        | 域名必须完成 ICP 备案（微信强制校验，未备案域名无法加入白名单）                                                         |
| TLS             | wss 需要 有效证书（不能自签）；自托管 relay 若走 80 明文只能用于开发调试                                                |
| relay 端口      | 建议 `wss://域名:443`（或 443 映射），非常用端口也可配置但域名规则相同                                                  |

自托管 relay 开启 TLS 的参考：域名 443 → 反向代理（Nginx/Caddy，挂 ICP 备案证书）→ relay `ws://127.0.0.1:<port>`，relay URI 用 `relay://域名:443/...?key=...&ssl=true`。

## 测试

```bash
cd miniprogram
npm run test                    # 单元 + 官方互通 + hub 客户端 mock + 直连 daemon 集成（daemon 离线自动 skip）
# relay 链路集成（URI 等同密码，经环境变量传入，不入库）：
PASEO_MP_TEST_RELAY_URI='relay://<host>:<port>/<serverId>?key=<urlencoded公钥>' npm run test
npm run typecheck               # src + tests 两个 tsconfig
```

- **官方互通**（`tests/e2ee-interop.test.ts`）：vendor 的客户端 E2EE 信道与主仓
  `@aaswitch/relay` 的 `createDaemonChannel`（官方 daemon 侧实现）在内存管道上握手、
  互发消息。主仓实现位置通过 `PASEO_MAIN_CHECKOUT` 环境变量或相邻检出路径探测，
  找不到时自动 skip。
- **hub 客户端**（`tests/hub-client.test.ts`）：Taro request/storage 全 mock；覆盖
  登录错误码中文映射（含真实 hub 的 401/409/429 + envelope 错误体）、token 存取、
  会话失效自动清理、devices.list 防御式解析、offer ↔ relay:// URI 往返。
- **集成**（`tests/integration-*.test.ts`）：Node `ws` 适配 + 真实 daemon
  （默认 `ws://127.0.0.1:6799`，可用 `PASEO_MP_TEST_DAEMON_URL` 覆盖）验证
  hello/server_info、agent 列表、时间线 tail、流订阅 ack。不向真实 agent 发消息
  （发送路径由单元测试覆盖，避免消耗模型配额）。

## UI 自动化验收

```bash
# 1. 微信开发者工具开 automation（服务端口需先在工具设置中开启）
<VS Code CLI>/cli auto --project <miniprogram 绝对路径> --auto-port 9421
# 2a. 对 mock hub：先 npm run mock:hub
node scripts/ui-automation.mjs
# 2b. 对真实 hub：先用 curl 注册账号并 devices.register 预置设备（见 docs/screenshots/README.md）
PROBE_USER=<user> PROBE_PASS=<pass> node scripts/ui-automation.mjs
```

脚本走完 登录（含错误码文案）→ 设备列表 → 点在线设备 E2EE 连接 → Agent 列表 →
详情 → 设置 全流程并截图到 `docs/screenshots/`。真实 hub 模式下设备 60s 无心跳判
离线（`HUB_ONLINE_TTL_MS`），脚本会用小程序 storage 里的 token 替预置设备发心跳保活。

## 范围与已知限制

- **daemon 侧 hub 注册/心跳未上线**：设备出现在列表里需要 daemon 侧实现
  `devices.register`/`devices.heartbeat`（hub API 已就绪）；当前用 curl 预置验证。
- **仅文本 JSON 帧**：daemon 的二进制帧（终端流、文件传输）被忽略——不做终端与文件浏览。
- **无自动重连**：断线后在设置页手动重连（`onDisconnect` 已广播到页面状态）。
- **时间线仅尾部 200 条**：不做分页加载历史。
- **PRNG 兜底降级**：基础库 ≥ 2.14.0 用 `wx.getRandomValues` 字节池；更老的基础库在池空时
  退化为非加密随机（nonce 复用风险）。建议真机基础库保持新版。
- **未实现**：agent 创建/删除、权限确认（permission_requested 仅显示状态）、通知推送、
  provider 快照、多 host 配置文件（仅保存最近一次连接）。
- **深色模式截图受限**：devtools darkmode 跟随系统外观，automation 无法切主题且本机
  Apple Events 权限未授予；双主题已由构建与 theme.json 验证（见 docs/screenshots/README.md）。

## 构建产物体积（实测 2026-10-22，Taro 4.3.0 + webpack5）

`npm run build:weapp` 后 `dist/` 全部产物 556KB —— 远低于微信 2MB 主包上限，无需分包。
