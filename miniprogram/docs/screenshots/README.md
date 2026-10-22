# UI 截图（自动化验收产物）

由 `scripts/ui-automation.mjs` 通过微信开发者工具 automation（端口 9421）驱动真实运行的
小程序生成，非设计稿。**本批截图全部对真实环境生成**：hub 为线上
`http://remoteagent.agentsworkforyou.cn/api`（curl 预置 `t15probe-*` 账号与两台设备），
设备连接走真实 relay E2EE，Agent 数据来自真实 daemon（0.5.0，监听 127.0.0.1:6767）。

复现（真实 hub 模式需先注册账号 + `devices.register` 预置设备；mock 模式 `npm run mock:hub`）：

```bash
<VS Code CLI>/cli auto --project <miniprogram 绝对路径> --auto-port 9421
PROBE_USER=<user> PROBE_PASS=<pass> node scripts/ui-automation.mjs
```

| 文件 | 页面 | 说明 |
| --- | --- | --- |
| `01-login.png` | 登录页 | aaswitch 品牌字标（aa 黑 + switch 品牌绿）；截图中错误文案为**真实 hub 401 auth.invalid_credentials → 中文映射** |
| `02-devices.png` | 设备列表（tab） | 真实 hub devices.list：在线设备（绿点胶囊，真实可连 offer）+ 离线设备（灰点，60s 无心跳判离线） |
| `03-agents.png` | Agent 列表 | 点击在线设备后经**真实 relay E2EE** 连接成功进入；agent 卡片数据来自真实 daemon |
| `04-agent-detail.png` | Agent 详情 | 真实 daemon 时间线（用户/助手/工具/todo 气泡、Markdown 渲染）、底部输入区与状态徽标 |
| `05-settings.png` | 设置（tab） | 真实账号用户名 / 设备连接（已连接态、daemon 0.5.0）/ Hub 服务器（线上地址）/ 高级 / 关于 分组 |
| `06-pair.png` | 手动配对 | 高级入口保留的 relay:// 粘贴 / 扫码页 |

## 深色模式

深色模式截图未包含在本批产物中：devtools 的 darkmode 跟随 macOS 系统外观，automation
API 不提供主题切换，切系统外观需要 Apple Events 权限（本机未授予 `System Events`，
osascript 返回 -1743）。深色支持已实现并通过构建验证：

- `src/app.config.ts`：`darkmode: true` + `themeLocation: "theme.json"`（导航栏/tabBar 双主题）；
- `src/theme.json`：light/dark 两套导航、tabBar 变量（dark 导航 #1E1E1E、tabBar #1E1E1E、选中色仍为品牌绿）；
- `src/app.css`：全部 design tokens 在 `@media (prefers-color-scheme: dark)` 下提供暗色值
  （背景 #111、卡片 #1E1E1E、填充 #2A2A2A、文字三阶 #E8EAED/#9DA3AE/#5F6672）。

在开发者工具中切换系统深色外观（或真机系统切深色、或授予终端 `System Events`
权限后跑 `node scripts/ui-automation.mjs --dark`）即可验证。
