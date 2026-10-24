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

| 文件                  | 页面            | 说明                                                                                                             |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `01-login.png`        | 登录页          | aaswitch 品牌字标（aa 黑 + switch 品牌绿）；截图中错误文案为**真实 hub 401 auth.invalid_credentials → 中文映射** |
| `02-devices.png`      | 设备列表（tab） | 真实 hub devices.list：在线设备（绿点胶囊，真实可连 offer）+ 离线设备（灰点，60s 无心跳判离线）                  |
| `03-agents.png`       | Agent 列表      | 点击在线设备后经**真实 relay E2EE** 连接成功进入；agent 卡片数据来自真实 daemon                                  |
| `04-agent-detail.png` | Agent 详情      | 真实 daemon 时间线（用户/助手/工具/todo 气泡、Markdown 渲染）、底部输入区与状态徽标                              |
| `05-settings.png`     | 设置（tab）     | 真实账号用户名 / 设备连接（已连接态、daemon 0.5.0）/ Hub 服务器（线上地址）/ 高级 / 关于 分组                    |
| `06-pair.png`         | 手动配对        | 高级入口保留的 relay:// 粘贴 / 扫码页                                                                            |

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

| 文件                                   | 页面       | 说明                                                                                                          |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `t16-01-agents-workspace-bar.png`      | Agent 列表 | 顶栏新增工作区栏 + 右上"新建"入口                                                                             |
| `t16-02-workspace-picker.png`          | 工作区选择 | 真实 `fetch_workspaces_request`：daemon 返回的工作区按项目分组、状态点                                        |
| `t16-03-agents-workspace-selected.png` | Agent 列表 | 选中工作区回填顶栏（选择持久化到 storage）                                                                    |
| `t16-04-create-form.png`               | 新建 Agent | 真实 provider 目录（claude/codex/copilot）+ 模型目录（picker）+ 任务指令                                      |
| `t16-05-agent-created.png`             | Agent 详情 | **真实创建的 agent**（短 prompt），创建后自动进入会话                                                         |
| `t16-06-agent-running-interrupt.png`   | Agent 详情 | （缺）短 prompt 执行过快、截图中 agent 已完成，中断按钮仅在 running 态展示；cancel RPC 由单测覆盖请求形状     |
| `t16-07-detail-actions.png`            | Agent 详情 | 操作区：状态徽标 + 删除（带确认弹层）                                                                         |
| `t16-08-permission-tool.png`           | 全局弹层   | 权限请求（工具授权）：mock 推送驱动——daemon 真实权限推送难以在自动化中自然触发；展示工具名/命令摘要/拒绝/允许 |
| `t16-09-permission-plan.png`           | 全局弹层   | 权限请求（计划确认）：协议多档 actions（继续规划 / 按计划实施）                                               |

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

| 文件                                    | 页面       | 说明                                                                                                                                     |
| --------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `t17-01-agents-files-entry.png`         | Agent 列表 | 工作区栏新增"文件"入口（工作区已选中）                                                                                                   |
| `t17-02-files-root.png`                 | 文件浏览器 | 真实 `file_explorer_request` mode:list：29 个条目，目录优先、图标/大小/时间、面包屑                                                      |
| `t17-03-files-subdir-chemflow.png`      | 文件浏览器 | 进入 `chemflow` 子目录（README.md 等真实文件）                                                                                           |
| `t17-04-text-preview.png`               | 文本预览   | `README.md` 二进制帧读取 → 内嵌渲染（等宽字体 + 下载保存按钮 + 截断提示）                                                                |
| `t17-05-pdf-download-opendocument.png`  | PDF 下载   | `method.pdf` 301KB 真实二进制流下载（进度条）→ `USER_DATA_PATH/paseo-files` → `wx.openDocument` 成功（页面 automation log 记录 ok:true） |
| `t17-06-smallfile-download.png`         | 下载保存   | `method.out` 长按 → 下载落地 3483B → 转发另存弹层（showModal mock 关闭）                                                                 |
| `t17-07-attach-uploaded.png`            | Agent 详情 | composer "+"（mock chooseMedia 上传真实 PNG 字节）→ `file.upload.request` + 二进制帧 → 绿色 ready 胶囊（文件名+大小）                    |
| `t17-08-attach-sent-timeline.png`       | Agent 详情 | 发送带附件消息（`send_agent_message` attachments + messageId 幂等）→ 时间线用户气泡渲染图片缩略附件卡片                                  |
| `t17-09-verification-agent-deleted.png` | Agent 列表 | 验证 agent 已删除（配额处置）                                                                                                            |

二进制帧编解码/文件树协议/上传下载状态机见 `tests/file-transfer-frames.test.ts`、
`tests/files-protocol.test.ts`；附件回配对（clientMessageId → 时间线 user_message）
见 `tests/message-attachment-store.test.ts`。功能覆盖全景见 `docs/parity-matrix.md`。

## t27 批次：手机号登录全链路（UI 修复 + 微信一键门控）

由 `scripts/ui-automation-t27.mjs`（端口 9432）对**公网手机号版 hub** 驱动生成：
注册随机 `139*` 测试号 → 自动登录 → 设置页改密 → 新密码再登录，全程真实 API；
`t27-00` 为修复前构建（`git stash` 回旧代码后另跑构建）的对照组截图。

| 文件                               | 页面             | 说明                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t27-00-login-before.png`          | 登录页（修复前） | 旧 username 表单：`.field-input` 只有竖向 padding 无显式高度，微信原生 input 不随 padding 撑高 → 输入框压扁、文字纵向截断（用户反馈 bug）                                                                                                         |
| `t27-01-login-fixed.png`           | 登录页（修复后） | `.field-input` 定高 88rpx + line-height 垂直居中（`flex-shrink:0` 防键盘压缩）；手机号表单（digit 键盘）；**微信一键按钮隐藏态**——登录页对 auth.wx-phone 探测，hub 返回 501 auth.wx_disabled 整块不渲染（automation 断言 `.btn-wx-phone` 不存在） |
| `t27-02-login-error.png`           | 登录页（错误态） | 真实 hub 401 auth.invalid_credentials → 中文映射「手机号或密码错误」                                                                                                                                                                              |
| `t27-03-settings-password.png`     | 设置（改密表单） | 账号区展示手机号（139\* 测试号）+ 修改密码表单（当前密码/新密码/确认，当前密码可省略当 passwordSet=false）                                                                                                                                        |
| `t27-04-settings-after-change.png` | 设置（改密后）   | 改密成功表单收起（其余设备已下线语义 toast）；旧密码 curl 复验 401、新密码 200                                                                                                                                                                    |
| `t27-05-login-dark.png`            | 登录页（深色档） | 手动深色档（theme-dark class），全部语义 token 无硬编码色（tests/dark-audit.test.ts 回归门）                                                                                                                                                      |

错误码中文映射 / 手机号归一化（+86/86/分隔符）/ wx 探测门控 / passwordSet 防御式解析
见 `tests/hub-client.test.ts`。

## t31a 批次：对话页三入口显性化（新建按钮 / 文件侧滑面板 / 导入入口）

由 `scripts/ui-automation-t31a.mjs`（端口 9420）对**隔离 daemon + mock hub** 驱动生成：
mock hub 6794（`MOCK_STATIC_DEVICES=0`，动态 devices.register 收纳隔离 daemon 注册）、
隔离 daemon 6796（`PASEO_HOME=/tmp/t31a-home`，hub 指向 mock，relay 走公网
remoteagent.agentsworkforyou.cn——模拟器屏蔽 ws://127.0.0.1 回环的既定 workaround），
演示工作区 `/tmp/t31a-workspace`（open_project 预注册）+ 无 prompt idle 会话（不耗配额）。
不触碰 6767/6799 主 daemon。

| 文件                             | 页面         | 说明                                                                                                                  |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `t31a-01-chat-header.png`        | 对话主页     | 顶栏显式 [＋ 新建]（品牌绿）与圆形文件按钮（t31 新增），会话标题/项目标签正常                                         |
| `t31a-02-files-panel-root.png`   | 文件侧滑面板 | 右侧滑入（左缘圆角 + 遮罩）：标题/工作区路径/上一级/面包屑「根」/目录优先文件列表                                     |
| `t31a-03-files-panel-subdir.png` | 文件侧滑面板 | 进入 src 子目录：面包屑「根 / src」当前段高亮，greet.ts 带图标与大小                                                  |
| `t31a-04-file-preview.png`       | 文件预览     | 面板点 README.md → files 页带 path/open 参数直达所在目录并自动打开文本预览（内容 + 编辑/下载保存）                    |
| `t31a-05-session-sheet.png`      | 会话弹窗     | 底部 [新建会话][导入已有会话] 并排（t31 显性化）；筛选标签与预建 idle 会话在列                                        |
| `t31a-06-import-tab.png`         | 创建页       | 会话弹窗「导入已有会话」→ `create?tab=import` 直达导入 tab（Provider 侧历史会话空态——隔离 home 无历史会话，符合预期） |
| `t31a-07-new-chat-welcome.png`   | 对话主页     | 从活跃会话点顶栏「新建」→ 快捷新对话欢迎态（标题「新对话」+「有什么要做的？」）                                       |
| `t31a-08-files-panel-dark.png`   | 文件侧滑面板 | 手动深色档（theme-dark）：面板/顶栏/列表全暗色 token，无浅色残留                                                      |

复现：`<cli> auto --project <miniprogram> --auto-port 9420` + 前置 mock hub/隔离 daemon
（见脚本头注释），`HUB_BASE=http://<LAN-IP>:6794/api node scripts/ui-automation-t31a.mjs`。
