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

## t16 批次：功能对齐（工作区/创建/控制/权限）

由 `scripts/ui-automation-t16.mjs`（端口 9422）对**真实 hub + 真实 daemon** 驱动生成：
探针账号 `t16probe-*`（curl 注册 + `devices.register` 预置带真实 relay offer 的
`t16-mac-dev` 设备），连接走真实 relay E2EE。**配额纪律：全程只创建一个真实
agent（claude / 短 prompt"只回复 ok"），验证后已删除**（删除经 `wx.showModal`
mock 确认后走真实 `delete_agent_request`）。

| 文件 | 页面 | 说明 |
| --- | --- | --- |
| `t16-01-agents-workspace-bar.png` | Agent 列表 | 顶栏新增工作区栏 + 右上"新建"入口 |
| `t16-02-workspace-picker.png` | 工作区选择 | 真实 `fetch_workspaces_request`：daemon 返回的工作区按项目分组、状态点 |
| `t16-03-agents-workspace-selected.png` | Agent 列表 | 选中工作区回填顶栏（选择持久化到 storage） |
| `t16-04-create-form.png` | 新建 Agent | 真实 provider 目录（claude/codex/copilot）+ 模型目录（picker）+ 任务指令 |
| `t16-05-agent-created.png` | Agent 详情 | **真实创建的 agent**（短 prompt），创建后自动进入会话 |
| `t16-06-agent-running-interrupt.png` | Agent 详情 | （缺）短 prompt 执行过快、截图中 agent 已完成，中断按钮仅在 running 态展示；cancel RPC 由单测覆盖请求形状 |
| `t16-07-detail-actions.png` | Agent 详情 | 操作区：状态徽标 + 删除（带确认弹层） |
| `t16-08-permission-tool.png` | 全局弹层 | 权限请求（工具授权）：mock 推送驱动——daemon 真实权限推送难以在自动化中自然触发；展示工具名/命令摘要/拒绝/允许 |
| `t16-09-permission-plan.png` | 全局弹层 | 权限请求（计划确认）：协议多档 actions（继续规划 / 按计划实施） |

权限弹层的推送→排队→回应状态机见 `tests/permission-store.test.ts`；RPC 形状与
推送路由见 `tests/protocol-t16.test.ts`（`agent_permission_request` 推送 +
`agent_permission_response` 回应）。深色模式限制同上节（新组件全部复用既有
tokens，`prefers-color-scheme: dark` 自动适配）。

## t17 批次：文件体系（浏览/预览/下载保存/附件上传）

由 `scripts/ui-automation-t17.mjs`（端口 9423）对**真实 hub + 真实 daemon** 驱动生成：
探针账号 `t17probe-*`（脚本自动注册 + `devices.register` 预置带真实 relay offer 的
`t17-mac-dev` 设备），连接走真实 relay E2EE。文件数据来自 daemon 真实工作区
（chemflow：`method.pdf` 301KB / `method.out` 3.4KB / `chemflow/README.md`）。
文件读写经 daemon WebSocket 的**二进制帧通道**（FileBegin/Chunk/End，
`file_explorer_request` + `file.upload.request`）。**配额纪律：全程只创建一个
真实 agent（短 prompt"只回复 ok"）用于附件验证，验证后已删除。**

| 文件 | 页面 | 说明 |
| --- | --- | --- |
| `t17-01-agents-files-entry.png` | Agent 列表 | 工作区栏新增"文件"入口（工作区已选中） |
| `t17-02-files-root.png` | 文件浏览器 | 真实 `file_explorer_request` mode:list：29 个条目，目录优先、图标/大小/时间、面包屑 |
| `t17-03-files-subdir-chemflow.png` | 文件浏览器 | 进入 `chemflow` 子目录（README.md 等真实文件） |
| `t17-04-text-preview.png` | 文本预览 | `README.md` 二进制帧读取 → 内嵌渲染（等宽字体 + 下载保存按钮 + 截断提示） |
| `t17-05-pdf-download-opendocument.png` | PDF 下载 | `method.pdf` 301KB 真实二进制流下载（进度条）→ `USER_DATA_PATH/paseo-files` → `wx.openDocument` 成功（页面 automation log 记录 ok:true） |
| `t17-06-smallfile-download.png` | 下载保存 | `method.out` 长按 → 下载落地 3483B → 转发另存弹层（showModal mock 关闭） |
| `t17-07-attach-uploaded.png` | Agent 详情 | composer "+"（mock chooseMedia 上传真实 PNG 字节）→ `file.upload.request` + 二进制帧 → 绿色 ready 胶囊（文件名+大小） |
| `t17-08-attach-sent-timeline.png` | Agent 详情 | 发送带附件消息（`send_agent_message` attachments + messageId 幂等）→ 时间线用户气泡渲染图片缩略附件卡片 |
| `t17-09-verification-agent-deleted.png` | Agent 列表 | 验证 agent 已删除（配额处置） |

二进制帧编解码/文件树协议/上传下载状态机见 `tests/file-transfer-frames.test.ts`、
`tests/files-protocol.test.ts`；附件回配对（clientMessageId → 时间线 user_message）
见 `tests/message-attachment-store.test.ts`。功能覆盖全景见 `docs/parity-matrix.md`。
