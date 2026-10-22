# 功能对齐矩阵（移动端 Web UI ↔ 微信小程序）

对照 `packages/app`（移动端 Web UI，Expo/Taro 之外的官方端）逐项盘点功能要素，
标注小程序当前覆盖状态。这是后续批次（t19+）与国产化终审的验收核对单。

图例：

- ✅tNN —— 已在批次 NN 交付并通过真实环境自动化验收
- 🔄tNN —— 下一批次计划
- ⏸ —— 适配项：依赖小程序平台能力，单独评估（非照搬实现）
- ➖ —— 不适用：官方端也仅限桌面/Electron 或浏览器形态

状态基线：develop-xdb @ t18（工作区 worktree `t18-miniprogram-ops`）。

## 1. 账号与设备（Hub）

| 功能要素                           | app 参照                             | 小程序状态 | 说明                                        |
| ---------------------------------- | ------------------------------------ | ---------- | ------------------------------------------- |
| 账号登录/登出                      | `screens/settings/host-account-page` | ✅t15      | 用户名密码 → hub auth.login，token 本机保存 |
| 设备列表（在线/离线）              | `hosts/`                             | ✅t15      | 60s 心跳窗口判离线，绿/灰点胶囊             |
| 设备连接（relay E2EE）             | `packages/client` relay transport    | ✅t15      | 二进制密文协商 + base64 兜底                |
| 手动配对（relay:// 粘贴/扫码）     | `screens/settings` 高级              | ✅t15      | 扫码 + 粘贴双入口                           |
| 设备注册/心跳保活（daemon 侧上报） | 桌面 daemon 自动                     | ➖         | 由桌面 daemon 承担，小程序仅消费            |
| 多设备切换/断开                    | hosts 列表                           | ✅t18      | 设置页新增"切换设备"入口直达设备 tab        |

## 2. 工作区与项目

| 功能要素                              | app 参照                         | 小程序状态      | 说明                                                        |
| ------------------------------------- | -------------------------------- | --------------- | ----------------------------------------------------------- |
| 工作区选择器（项目分组/状态）         | `screens/new-workspace-picker-*` | ✅t16           | fetch_workspaces，按项目分组 + 状态点                       |
| 选中持久化（按设备隔离）              | workspace store                  | ✅t16           | Taro storage，断开清理                                      |
| 新建工作区（git clone/worktree/fork） | `screens/new-workspace-screen`   | ✅t18（最小）   | 本地目录注册（open_project）+ GitHub clone（github.clone）；worktree/fork 隔离与 setup 终端反馈 🔄t19 |
| 工作区状态轮询/attention              | workspace header                 | ✅t16（列表态） | 状态桶展示                                                  |
| 项目设置/工作区归档                   | `project-settings-screen`        | 🔄t19           |                                                             |

## 3. Agent 会话

| 功能要素                                           | app 参照                                 | 小程序状态    | 说明                                        |
| -------------------------------------------------- | ---------------------------------------- | ------------- | ------------------------------------------- |
| Agent 列表（状态/provider/attention）              | `components/agent-list`                  | ✅t15/t18     | t18：agent_update 订阅修复（fetch_agents subscribe）+ 归档/需注意/全部筛选 |
| 创建 Agent（provider/model/mode/prompt）           | `composer` + create flow                 | ✅t16         | 真实 provider 目录；worktree 选项 🔄t19     |
| 时间线（user/assistant/reasoning/tool/todo/error） | `agent-stream/`                          | ✅t15         | 气泡体系 + seq 去重 + 乐观追加              |
| Markdown 渲染（代码块/表格/链接）                  | `markdown-renderer`                      | 🔄t19         | t15 纯文本；富渲染下一批                    |
| 发消息（steer/queue 行为）                         | composer submit                          | ✅t15（基础） | activeTurnBehavior 选项 🔄t19               |
| 中断 / 删除 Agent                                  | `agent-controls`                         | ✅t16         | cancel_agent / delete_agent                 |
| 归档 / 恢复                                        | agent archive                            | ✅t18         | archive_agent / refresh_agent（unarchive）  |
| Subagents 轨道                                     | `subagents/`                             | 🔄t19         |                                             |
| Agent 标签/重命名/资料卡                           | `agent-profiles` `agent-labels`          | ✅t18（标签） | 标签展示与打标签（update_agent labels）；重命名/资料卡 🔄t19 |
| 命令面板 / 斜杠命令                                | `client-slash-commands` `command-center` | 🔄t19         |                                             |
| 会话导入                                           | chat settings                            | ✅t18         | fetch_recent_provider_sessions + import_agent（创建页"导入"tab） |
| 会话导出                                           | chat settings                            | 🔄t19         |                                             |
| 上下文窗口/压缩指示                                | `context-window-*`                       | 🔄t19         | todo/compaction 气泡已有，计量条未做        |

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
| 文件订阅变更（fs.file.subscribe）            | file watch                              | 🔄t19      | 协议已考古（subscribe/update 推送），UI 未接                          |
| 文件编辑/写回（fs.file.write）               | file editor                             | 🔄t19      | 冲突（modifiedAt/revision）协议已知                                   |
| 新建/重命名/删除条目（fs.entry.\*）          | explorer 操作                           | 🔄t19      |                                                                       |
| 附件上传（选图/选文件 → uploaded_file）      | `attachments/` + composer               | ✅t17      | file.upload.request + FileBegin/Chunk/End 二进制帧                    |
| 附件随消息发送                               | composer submit                         | ✅t17      | send_agent_message attachments + messageId 幂等                       |
| 时间线附件卡片（图片缩略/文件名+大小）       | `components/message` attachment pill    | ✅t17      | 本地台账 clientMessageId 回配对 + 同文本兜底                          |
| 工作区文件拖入对话                           | `attachments/workspace-file-drag`       | ➖         | 小程序无拖拽；以"文件页下载后转发/上传"替代                           |
| 文件 diff 浏览（checkout.commits.file_diff） | diff panel                              | 🔄t19      |                                                                       |

## 6. 终端与浏览器面板

| 功能要素                          | app 参照                     | 小程序状态 | 说明                                                                                          |
| --------------------------------- | ---------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 工作区终端（PTY 流）              | `terminal/` + terminal-panel | ⏸          | 终端流二进制帧协议（TerminalStreamOpcode）已考古；小程序渲染面（等宽滚动 + 输入条）待专项评估 |
| 浏览器面板（webview/Browser Use） | `desktop/browser`            | ➖         | Electron 专属（webviewTag）                                                                   |
| 服务代理公网 URL                  | `service-proxy`              | ✅t18      | 脚本页展示 publicProxyUrl 主机；不承载反代                                                    |

## 7. 定时任务与脚本

| 功能要素               | app 参照                                | 小程序状态 | 说明                                                       |
| ---------------------- | --------------------------------------- | ---------- | ---------------------------------------------------------- |
| 定时任务列表/创建/启停 | `screens/schedules-screen` `schedules/` | ✅t18      | schedule/list/create/pause/resume/delete/run-once/logs；cron 预设 + 自定义（客户端 5 字段校验）；目标可选已有 agent 或每次新建 |
| 工作区脚本运行         | workspace scripts                       | ✅t18      | workspace.script.list/start/stop；生命周期/健康状态展示    |
| 脚本输出时间线         | scripts panel                           | 🔄t19      | 输出走终端流二进制帧（terminalId），渲染面随终端专项评估   |

## 8. 通知与提醒

| 功能要素                    | app 参照               | 小程序状态    | 说明                                          |
| --------------------------- | ---------------------- | ------------- | --------------------------------------------- |
| attention 红点（列表/详情） | attention dot          | ✅t15/t18     | 列表红点 + 高亮卡片                           |
| attention 实时提醒          | `push-notifications/`  | ✅t18（前台） | agent_attention_required 推送（legacy 免订阅）→ tabBar 徽标（设备 tab 计数）+ wx.vibrateShort（可关）；后台推送订阅消息 ⏸ 模板审批 |
| 推送通知注册                | `push-notifications/`  | ⏸            | 微信订阅消息需模板审批，单独评估               |
| 通知设置                    | settings notifications | ✅t18（振动） | 订阅消息设置 ⏸                                |

## 9. 设置与外观

| 功能要素                           | app 参照              | 小程序状态    | 说明                                       |
| ---------------------------------- | --------------------- | ------------- | ------------------------------------------ |
| 账号/设备连接信息                  | settings host         | ✅t15         |                                            |
| daemon 状态（版本/relay 端点）     | daemon status         | ✅t15         | daemon.get_status                          |
| 深色模式                           | appearance            | ✅t15/t18     | t18：三档主题（跟随系统/浅色/深色）——页面 tokens 双轨覆盖 + 导航/tabBar wx API 显式着色 |
| 语言/i18n                          | `i18n/`               | ✅t15（中文） | 多语言未排期（t18 砍尾项）                 |
| 集成（forge/editor/browser tools） | settings integrations | 🔄t19         |                                            |
| 关于/诊断                          | settings              | ✅t15（基础） | 诊断导出 🔄t19                             |

## 10. 其他平台面

| 功能要素                       | app 参照              | 小程序状态          | 说明                                        |
| ------------------------------ | --------------------- | ------------------- | ------------------------------------------- |
| 语音输入/听写                  | `audio/` `dictation/` | ⏸                   | wx 录音 API 可行，转写链路单独评估          |
| 图片消息（base64 images 直发） | composer images       | ✅t17（经附件通道） | 小程序统一走 uploaded_file 附件（协议等价） |
| 插件/原生面                    | `plugins/`            | ➖                  | 桌面端专属                                  |
| MCP 服务器管理                 | settings mcp          | 🔄t19               |                                             |

## 覆盖统计

- ✅ 已覆盖（t15–t18）：设备/连接/工作区选择与新建（最小）/创建 Agent/时间线/控制/权限/文件浏览/预览/下载保存/附件上传与展示/定时任务全链路/脚本启停/归档恢复/标签/attention 前台提醒/会话导入/三档主题 —— 移动端运营面已闭环。
- 🔄t19 计划：Markdown 富渲染、文件写回与条目操作、diff、subagents、斜杠命令、上下文计量、脚本输出时间线、工作区归档/项目设置、集成设置、诊断导出。
- ⏸ 适配项：终端流（协议已就绪，渲染面待评估）、后台推送订阅消息、语音听写。
- ➖ 不适用：浏览器面板、插件原生面、工作区文件拖拽、多设备端侧能力。

## 验收证据

- 单测：`tests/protocol-t18.test.ts`（schedule/attention/归档标签/导入/项目注册/脚本 RPC 全链路 mock socket）、`tests/ops-stores.test.ts`（cron 校验、cadence 文案、目录筛选/标签、attention store、theme store）。
- 真实环境自动化：`scripts/ui-automation-t18.mjs`（真实 hub + 真实 daemon 经 relay E2EE）：登录→连接→创建验证 agent→创建 cron 每分钟定时任务→立即执行→schedule/logs 执行记录→agent 时间线出现执行回复→真实 attention 推送徽标/高亮→打标签→归档/恢复→归档筛选→导入 tab（49 条真实 provider 会话）→脚本页→工作区目录幂等注册→三档主题→删除任务与 agent。截图 `docs/screenshots/t18-*.png`。
