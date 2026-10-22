# 功能对齐矩阵（移动端 Web UI ↔ 微信小程序）

对照 `packages/app`（移动端 Web UI，Expo/Taro 之外的官方端）逐项盘点功能要素，
标注小程序当前覆盖状态。这是国产化验收的核对单（t19 终审版）。

图例：

- ✅tNN —— 已在批次 NN 交付并通过真实环境自动化验收
- ✅ —— 交付较早（t15–t18），状态沿袭
- 🔄t20 —— 未做：已评估，建议后续批次（附原因）
- ⏸ —— 适配项：依赖小程序平台能力，单独评估（非照搬实现）
- ➖ —— 不适用：官方端也仅限桌面/Electron 或浏览器形态

状态基线：develop-xdb @ t19 终审（worktree `t19-miniprogram-final`）。

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
| 新建工作区（git clone/worktree/fork） | `screens/new-workspace-screen`   | ✅t18（最小）   | 本地目录注册（open_project）+ GitHub clone（github.clone）；worktree/fork 隔离建仓未做——`create_paseo_worktree_request`/fork 链路需独立建页，且 agent 侧 worktree 隔离（见 §3）已覆盖主场景 → 🔄t20 |
| 工作区状态轮询/attention              | workspace header                 | ✅t16（列表态） | 状态桶展示                                                  |
| 项目设置/工作区归档                   | `project-settings-screen`        | 🔄t20           | 低频管理面：需 worktree 列表/归档 RPC（paseo_worktree_archive）+ 项目设置页；建议独立小批次 |

## 3. Agent 会话

| 功能要素                                           | app 参照                                 | 小程序状态    | 说明                                        |
| -------------------------------------------------- | ---------------------------------------- | ------------- | ------------------------------------------- |
| Agent 列表（状态/provider/attention）              | `components/agent-list`                  | ✅t15/t18     | t18：agent_update 订阅修复（fetch_agents subscribe）+ 归档/需注意/全部筛选 |
| 创建 Agent（provider/model/mode/prompt）           | `composer` + create flow                 | ✅t16/t19     | 真实 provider 目录；t19：worktree 隔离选项（create_agent worktree branch-off，开关+新分支名） |
| 时间线（user/assistant/reasoning/tool/todo/error） | `agent-stream/`                          | ✅t15         | 气泡体系 + seq 去重 + 乐观追加              |
| Markdown 渲染（代码块/表格/链接）                  | `markdown-renderer`                      | ✅t19         | 自写轻量渲染器（block/inline 两级 AST→View，无 eval）：标题/有序无序列表（两层）/引用/GFM 表格/分隔线/代码围栏（等宽+横向滚动+复制）/行内码/粗斜删/链接（复制+浏览器打开提示）。对照 app 原生引擎的简化：行内标记不嵌套、无 mermaid/数学/HTML/tasklist、无流式分块渲染——矩阵终审接受 |
| 发消息（steer/queue 行为）                         | composer submit                          | ✅t15/t19     | t19：运行中发送行为 toggle（steer 插入 / interrupt 先中断），activeTurnBehavior 随消息声明 |
| 中断 / 删除 Agent                                  | `agent-controls`                         | ✅t16         | cancel_agent / delete_agent                 |
| 归档 / 恢复                                        | agent archive                            | ✅t18         | archive_agent / refresh_agent（unarchive）  |
| Subagents 轨道                                     | `subagents/`                             | ✅t19         | provider_subagents.list + update 推送（upsert/remove 实时维护）；标题/描述/副题/状态四态点。子代理时间线详情（timeline.get + 独立视图）未做 → 低频，🔄t20 备注 |
| Agent 标签/重命名/资料卡                           | `agent-profiles` `agent-labels`          | ✅t18/t19     | 标签（t18）；重命名（t19：update_agent name，导航栏同步）。资料卡（profile 详情页）未做 → 列表态信息已覆盖，价值低 |
| 命令面板 / 斜杠命令                                | `client-slash-commands` `command-center` | ✅t19         | composer 输入 "/" 触发 list_commands 目录（前缀过滤 + 点按填充）；真实 daemon 现网该 agent 目录为空（RPC 闭环已验证，空目录面板不弹属预期）。全局命令面板（command-center 搜索/最近）未做 → 🔄t20 |
| 会话导入                                           | chat settings                            | ✅t18         | fetch_recent_provider_sessions + import_agent（创建页"导入"tab） |
| 会话导出                                           | chat settings                            | ✅t19         | 时间线 → markdown → 剪贴板（与官方 app 的剪贴板导出同路径；小程序无文件系统落盘诉求） |
| 上下文窗口/压缩指示                                | `context-window-*`                       | ✅t19         | lastUsage（contextWindowUsed/MaxTokens）百分比计量条（≥80% 变红），agent_update 全量推送驱动；todo/compaction 气泡 t15 已有 |

## 4. 权限

| 功能要素                 | app 参照          | 小程序状态 | 说明                               |
| ------------------------ | ----------------- | ---------- | ---------------------------------- |
| 权限请求弹层（工具授权） | `permission` 卡片 | ✅t16      | actions 缺省补默认两档             |
| 计划确认（多档动作）     | plan 卡片         | ✅t16      | 多档 actions 渲染                  |
| 排队/已解决推送同步      | permission store  | ✅t16      | agent_permission_resolved 驱动清队 |

## 5. 文件体系（t17 建立，t19 补写回/条目/订阅/diff）

| 功能要素                                     | app 参照                                | 小程序状态 | 说明                                                                  |
| -------------------------------------------- | --------------------------------------- | ---------- | --------------------------------------------------------------------- |
| 文件浏览器（目录树/返回/图标/大小/时间）     | `file-explorer/` + `panels/files-panel` | ✅t17      | file_explorer_request mode:list，目录优先排序                         |
| 文本/代码预览（大文件截断提示）              | file panel preview                      | ✅t17      | maxBytes 512KB + 64K 字符渲染上限                                     |
| 图片预览（缩略 + 全屏）                      | attachment lightbox                     | ✅t17      | 二进制帧读取 → 本地落地 → wx.previewImage                             |
| PDF/Office 预览                              | 下载后系统打开                          | ✅t17      | 下载 → wx.openDocument（pdf/doc(x)/xls(x)/ppt(x)）                    |
| 下载保存到手机                               | 下载管理                                | ✅t17      | USER_DATA_PATH/paseo-files + 进度条 + 转发另存（wx.shareFileMessage） |
| 文件订阅变更（fs.file.subscribe）            | file watch                              | ✅t19      | 编辑器打开期间订阅 → fs.file.update 推送 → "远端已修改"横幅（保存冲突检测兜底） |
| 文件编辑/写回（fs.file.write）               | file editor                             | ✅t19      | 预览进编辑器（textarea）；expectedModifiedAt/revision 冲突协议 + 三选处理（重新加载/覆盖远端/继续编辑），状态机单测覆盖 |
| 新建/重命名/删除条目（fs.entry.\*）          | explorer 操作                           | ✅t19      | 头部"＋"新建文件/文件夹（可输入弹窗）；长按重命名/下载/删除（删除带确认） |
| 附件上传（选图/选文件 → uploaded_file）      | `attachments/` + composer               | ✅t17      | file.upload.request + FileBegin/Chunk/End 二进制帧                    |
| 附件随消息发送                               | composer submit                         | ✅t17      | send_agent_message attachments + messageId 幂等                       |
| 时间线附件卡片（图片缩略/文件名+大小）       | `components/message` attachment pill    | ✅t17      | 本地台账 clientMessageId 回配对 + 同文本兜底                          |
| 工作区文件拖入对话                           | `attachments/workspace-file-drag`       | ➖         | 小程序无拖拽；以"文件页下载后转发/上传"替代                           |
| 文件 diff 浏览（checkout.commits.file_diff） | diff panel                              | ✅t19      | "改动"页：commits 列表（短 sha/作者/已推送徽标）→ 展开文件（+−统计/状态）→ 逐行着色只读 diff（横向滚动，hunk 头） |

## 6. 终端与浏览器面板

| 功能要素                          | app 参照                     | 小程序状态      | 说明                                                                                          |
| --------------------------------- | ---------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| 工作区终端（PTY 流）              | `terminal/` + terminal-panel | ✅t19（适配版） | subscribe_terminal（visible-snapshot 回放）→ TerminalStream 帧（Restore/Output/Snapshot）→ ANSI 剥离纯文本行 + 行输入（terminal_input）。对照 app xterm 的简化：无 ANSI 着色/光标定位/键级输入/resize；工作区终端（create_terminal）+ 脚本输出两个入口 |
| 浏览器面板（webview/Browser Use） | `desktop/browser`            | ➖              | Electron 专属（webviewTag）                                                                   |
| 服务代理公网 URL                  | `service-proxy`              | ✅t18           | 脚本页展示 publicProxyUrl 主机；不承载反代                                                    |

## 7. 定时任务与脚本

| 功能要素               | app 参照                                | 小程序状态 | 说明                                                       |
| ---------------------- | --------------------------------------- | ---------- | ---------------------------------------------------------- |
| 定时任务列表/创建/启停 | `screens/schedules-screen` `schedules/` | ✅t18      | schedule/list/create/pause/resume/delete/run-once/logs；cron 预设 + 自定义（客户端 5 字段校验）；目标可选已有 agent 或每次新建 |
| 工作区脚本运行         | workspace scripts                       | ✅t18      | workspace.script.list/start/stop；生命周期/健康状态展示    |
| 脚本输出时间线         | scripts panel                           | ✅t19      | terminalId → "输出"按钮 → 终端页（同 §6 适配版终端流）     |

## 8. 通知与提醒

| 功能要素                    | app 参照               | 小程序状态    | 说明                                          |
| --------------------------- | ---------------------- | ------------- | --------------------------------------------- |
| attention 红点（列表/详情） | attention dot          | ✅t15/t18     | 列表红点 + 高亮卡片                          |
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
| 集成（forge/editor/browser tools） | settings integrations | 🔄t20         | 纯管理面、低频；providers snapshot/mcp 配置 RPC 族需整组考古，建议随 MCP 管理合并批次 |
| 关于/诊断                          | settings              | ✅t15（基础） | 版本/连接信息展示；诊断导出未做 → 错误信息已就地展示，价值低，归入 t20 集成批次顺带 |

## 10. 其他平台面

| 功能要素                       | app 参照              | 小程序状态          | 说明                                        |
| ------------------------------ | --------------------- | ------------------- | ------------------------------------------- |
| 语音输入/听写                  | `audio/` `dictation/` | ⏸                   | wx 录音 API 可行，转写链路单独评估          |
| 图片消息（base64 images 直发） | composer images       | ✅t17（经附件通道） | 小程序统一走 uploaded_file 附件（协议等价） |
| 插件/原生面                    | `plugins/`            | ➖                   | 桌面端专属                                  |
| MCP 服务器管理                 | settings mcp          | 🔄t20               | mcp.\* RPC 族未考古；管理面低频，与集成设置合并批次 |

## 覆盖统计（终审）

按上表逐行计（共 60 行）：

- ✅ 已覆盖 **51** 项（其中 t19 新增 12 项：Markdown 富渲染、activeTurnBehavior、subagents 轨道、重命名、斜杠命令、会话导出、上下文计量条、文件订阅变更、文件写回、条目操作、文件 diff、适配版终端流（含脚本输出））
- 🔄t20 待做 **3** 项：项目设置/工作区归档（低频管理面）、集成设置+诊断导出（RPC 族整组考古）、MCP 服务器管理（同前）
- ⏸ 适配评估 **2** 项：后台推送订阅消息（微信模板审批门槛）、语音听写（转写链路）
- ➖ 不适用 **4** 项：daemon 侧设备注册（桌面承担）、工作区文件拖拽（无拖拽能力）、浏览器面板（Electron 专属）、插件原生面（桌面专属）

结论：移动端运营面（连接/会话/权限/文件/终端输出/定时/脚本/通知/外观）已全链路闭环；剩余 3 项均为低频管理面，可并入一个收尾小批次（t20），2 项平台适配项单独评估。

## 验收证据

- 单测（`npx vitest run` 全绿，218 通过 / 1 跳过）：
  - `tests/protocol-t19.test.ts`（t19 全部新 RPC 的 mock socket 全链路：writeFile written/conflict、fs.entry.\*、fs.file.subscribe→update、commits/file_diff、subscribe_terminal→slot/帧路由/terminal_input/exit、create_terminal、subagents list/update、list_commands、activeTurnBehavior、create worktree）
  - `tests/markdown.test.ts`（块级/行内/综合快照 13 例）、`tests/file-edit.test.ts`（写回冲突状态机 8 例）、`tests/terminal.test.ts`（ANSI 剥离/行缓冲/帧编解码 14 例）、`tests/diff-protocol.test.ts`（commits/diff 容错解析 6 例）
  - 既有 15 个套件不回归。
- 真实环境自动化：`scripts/ui-automation-t19.mjs`（真实 hub + 真实 daemon 经 relay E2EE）。本轮 daemon 全部 provider 账号不可用（opencode/claude 403、codex 默认模型 404），markdown 按任务书允许的替代路径用已有 agent 真实历史验证；文件/终端/diff/重命名均真实 RPC 闭环。截图 `docs/screenshots/t19-*.png`（14 张，证据索引见 `docs/final-acceptance.md`）。
