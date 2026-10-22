# 功能对齐矩阵（移动端 Web UI ↔ 微信小程序）

对照 `packages/app`（移动端 Web UI，Expo/Taro 之外的官方端）逐项盘点功能要素，
标注小程序当前覆盖状态。这是后续批次（t18+）与国产化终审的验收核对单。

图例：

- ✅tNN —— 已在批次 NN 交付并通过真实环境自动化验收
- 🔄t18 —— 下一批次计划
- ⏸ —— 适配项：依赖小程序平台能力，单独评估（非照搬实现）
- ➖ —— 不适用：官方端也仅限桌面/Electron 或浏览器形态

状态基线：develop-xdb @ t17（工作区 worktree `t17-miniprogram-files`）。

## 1. 账号与设备（Hub）

| 功能要素                           | app 参照                             | 小程序状态 | 说明                                        |
| ---------------------------------- | ------------------------------------ | ---------- | ------------------------------------------- |
| 账号登录/登出                      | `screens/settings/host-account-page` | ✅t15      | 用户名密码 → hub auth.login，token 本机保存 |
| 设备列表（在线/离线）              | `hosts/`                             | ✅t15      | 60s 心跳窗口判离线，绿/灰点胶囊             |
| 设备连接（relay E2EE）             | `packages/client` relay transport    | ✅t15      | 二进制密文协商 + base64 兜底                |
| 手动配对（relay:// 粘贴/扫码）     | `screens/settings` 高级              | ✅t15      | 扫码 + 粘贴双入口                           |
| 设备注册/心跳保活（daemon 侧上报） | 桌面 daemon 自动                     | ➖         | 由桌面 daemon 承担，小程序仅消费            |
| 多设备切换/断开                    | hosts 列表                           | ✅t15      | 切换即断开重连，会话态清理                  |

## 2. 工作区与项目

| 功能要素                              | app 参照                         | 小程序状态      | 说明                                  |
| ------------------------------------- | -------------------------------- | --------------- | ------------------------------------- |
| 工作区选择器（项目分组/状态）         | `screens/new-workspace-picker-*` | ✅t16           | fetch_workspaces，按项目分组 + 状态点 |
| 选中持久化（按设备隔离）              | workspace store                  | ✅t16           | Taro storage，断开清理                |
| 新建工作区（git clone/worktree/fork） | `screens/new-workspace-screen`   | 🔄t18           | 依赖 git 集成面板与 setup 终端反馈    |
| 工作区状态轮询/attention              | workspace header                 | ✅t16（列表态） | 状态桶展示；实时订阅 🔄t18            |
| 项目设置/工作区归档                   | `project-settings-screen`        | 🔄t18           |                                       |

## 3. Agent 会话

| 功能要素                                           | app 参照                                 | 小程序状态    | 说明                                    |
| -------------------------------------------------- | ---------------------------------------- | ------------- | --------------------------------------- |
| Agent 列表（状态/provider/attention）              | `components/agent-list`                  | ✅t15         | 下拉刷新 + agent_update 增量            |
| 创建 Agent（provider/model/mode/prompt）           | `composer` + create flow                 | ✅t16         | 真实 provider 目录；worktree 选项 🔄t18 |
| 时间线（user/assistant/reasoning/tool/todo/error） | `agent-stream/`                          | ✅t15         | 气泡体系 + seq 去重 + 乐观追加          |
| Markdown 渲染（代码块/表格/链接）                  | `markdown-renderer`                      | 🔄t18         | t15 纯文本；富渲染下一批                |
| 发消息（steer/queue 行为）                         | composer submit                          | ✅t15（基础） | activeTurnBehavior 选项 🔄t18           |
| 中断 / 删除 Agent                                  | `agent-controls`                         | ✅t16         | cancel_agent / delete_agent             |
| 归档 / 恢复                                        | agent archive                            | 🔄t18         |                                         |
| Subagents 轨道                                     | `subagents/`                             | 🔄t18         |                                         |
| Agent 标签/重命名/资料卡                           | `agent-profiles` `agent-labels`          | 🔄t18         |                                         |
| 命令面板 / 斜杠命令                                | `client-slash-commands` `command-center` | 🔄t18         |                                         |
| 会话导入导出                                       | chat settings                            | 🔄t18         |                                         |
| 上下文窗口/压缩指示                                | `context-window-*`                       | 🔄t18         | todo/compaction 气泡已有，计量条未做    |

## 4. 权限

| 功能要素                 | app 参照          | 小程序状态 | 说明                               |
| ------------------------ | ----------------- | ---------- | ---------------------------------- |
| 权限请求弹层（工具授权） | `permission` 卡片 | ✅t16      | actions 缺省补默认两档             |
| 计划确认（多档动作）     | plan 卡片         | ✅t16      | 多档 actions 渲染                  |
| 排队/已解决推送同步      | permission store  | ✅t16      | agent_permission_resolved 驱动清队 |

## 5. 文件体系（t17）

| 功能要素                                     | app 参照                                | 小程序状态 | 说明                                                                  |
| -------------------------------------------- | --------------------------------------- | ---------- | --------------------------------------------------------------------- |
| 文件浏览器（目录树/返回/图标/大小/时间）     | `file-explorer/` + `panels/files-panel` | ✅t17      | file_explorer_request mode:list，目录优先排序                         |
| 文本/代码预览（大文件截断提示）              | file panel preview                      | ✅t17      | maxBytes 512KB + 64K 字符渲染上限                                     |
| 图片预览（缩略 + 全屏）                      | attachment lightbox                     | ✅t17      | 二进制帧读取 → 本地落地 → wx.previewImage                             |
| PDF/Office 预览                              | 下载后系统打开                          | ✅t17      | 下载 → wx.openDocument（pdf/doc(x)/xls(x)/ppt(x)）                    |
| 下载保存到手机                               | 下载管理                                | ✅t17      | USER_DATA_PATH/paseo-files + 进度条 + 转发另存（wx.shareFileMessage） |
| 文件订阅变更（fs.file.subscribe）            | file watch                              | 🔄t18      | 协议已考古（subscribe/update 推送），UI 未接                          |
| 文件编辑/写回（fs.file.write）               | file editor                             | 🔄t18      | 冲突（modifiedAt/revision）协议已知                                   |
| 新建/重命名/删除条目（fs.entry.\*）          | explorer 操作                           | 🔄t18      |                                                                       |
| 附件上传（选图/选文件 → uploaded_file）      | `attachments/` + composer               | ✅t17      | file.upload.request + FileBegin/Chunk/End 二进制帧                    |
| 附件随消息发送                               | composer submit                         | ✅t17      | send_agent_message attachments + messageId 幂等                       |
| 时间线附件卡片（图片缩略/文件名+大小）       | `components/message` attachment pill    | ✅t17      | 本地台账 clientMessageId 回配对 + 同文本兜底                          |
| 工作区文件拖入对话                           | `attachments/workspace-file-drag`       | ➖         | 小程序无拖拽；以"文件页下载后转发/上传"替代                           |
| 文件 diff 浏览（checkout.commits.file_diff） | diff panel                              | 🔄t18      |                                                                       |

## 6. 终端与浏览器面板

| 功能要素                          | app 参照                     | 小程序状态 | 说明                                                                                          |
| --------------------------------- | ---------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 工作区终端（PTY 流）              | `terminal/` + terminal-panel | ⏸          | 终端流二进制帧协议（TerminalStreamOpcode）已考古；小程序渲染面（等宽滚动 + 输入条）待专项评估 |
| 浏览器面板（webview/Browser Use） | `desktop/browser`            | ➖         | Electron 专属（webviewTag）                                                                   |
| 服务代理公网 URL                  | `service-proxy`              | 🔄t18      | 展示/复制入口，不承载反代                                                                     |

## 7. 定时任务与脚本

| 功能要素               | app 参照                                | 小程序状态 | 说明                       |
| ---------------------- | --------------------------------------- | ---------- | -------------------------- |
| 定时任务列表/创建/启停 | `screens/schedules-screen` `schedules/` | 🔄t18      | schedule.\* RPC 考古随批做 |
| 工作区脚本运行         | workspace scripts                       | 🔄t18      |                            |
| 脚本输出时间线         | scripts panel                           | 🔄t18      |                            |

## 8. 通知与提醒

| 功能要素                    | app 参照               | 小程序状态 | 说明                             |
| --------------------------- | ---------------------- | ---------- | -------------------------------- |
| attention 红点（列表/详情） | attention dot          | ✅t15      | requiresAttention 渲染           |
| 推送通知注册                | `push-notifications/`  | ⏸          | 微信订阅消息需模板审批，单独评估 |
| 通知设置                    | settings notifications | ⏸          | 同上                             |

## 9. 设置与外观

| 功能要素                           | app 参照              | 小程序状态    | 说明                                |
| ---------------------------------- | --------------------- | ------------- | ----------------------------------- |
| 账号/设备连接信息                  | settings host         | ✅t15         |                                     |
| daemon 状态（版本/relay 端点）     | daemon status         | ✅t15         | daemon.get_status                   |
| 深色模式                           | appearance            | ✅t15         | darkmode + theme.json + tokens 双轨 |
| 语言/i18n                          | `i18n/`               | ✅t15（中文） | 多语言 🔄t18                        |
| 集成（forge/editor/browser tools） | settings integrations | 🔄t18         |                                     |
| 关于/诊断                          | settings              | ✅t15（基础） | 诊断导出 🔄t18                      |

## 10. 其他平台面

| 功能要素                       | app 参照              | 小程序状态          | 说明                                        |
| ------------------------------ | --------------------- | ------------------- | ------------------------------------------- |
| 语音输入/听写                  | `audio/` `dictation/` | ⏸                   | wx 录音 API 可行，转写链路单独评估          |
| 图片消息（base64 images 直发） | composer images       | ✅t17（经附件通道） | 小程序统一走 uploaded_file 附件（协议等价） |
| 插件/原生面                    | `plugins/`            | ➖                  | 桌面端专属                                  |
| MCP 服务器管理                 | settings mcp          | 🔄t18               |                                             |

## 覆盖统计

- ✅ 已覆盖（t15–t17）：设备/连接/工作区选择/创建 Agent/时间线/控制/权限/文件浏览/预览/下载保存/附件上传与展示 —— 移动端 Web UI 核心操作路径已闭环。
- 🔄t18 计划：新建工作区、Markdown 富渲染、文件写回与条目操作、diff、定时任务、脚本、归档/标签、斜杠命令、上下文计量、多语言、集成设置。
- ⏸ 适配项：终端流（协议已就绪，渲染面待评估）、推送通知（订阅消息）、语音听写。
- ➖ 不适用：浏览器面板、插件原生面、工作区文件拖拽、多设备端侧能力。

## 验收证据

- 单测：`tests/file-transfer-frames.test.ts`（帧编解码）、`tests/files-protocol.test.ts`（文件树/上传/下载状态机）、`tests/message-attachment-store.test.ts`（附件回配对）。
- 真实环境自动化：`scripts/ui-automation-t17.mjs`（真实 hub + 真实 daemon 经 relay E2EE），截图 `docs/screenshots/t17-*.png`。
