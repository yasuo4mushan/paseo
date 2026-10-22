# t19 终审验收报告（微信小程序国产化 · 功能对齐终批）

对照 `docs/parity-matrix.md`（t19 终审版）逐类列出验证方式与证据。验证环境：真实 hub
（remoteagent.agentsworkforyou.cn）+ 真实 daemon（.paseo-xdb）经 relay E2EE；自动化走微信
开发者工具 automator（端口 9425），脚本 `scripts/ui-automation-t19.mjs`。

环境备注（终审当日实况）：daemon 侧全部 provider 账号不可用——opencode/claude 返回
`403 Request not allowed`、codex 默认模型 `GPT-5.6-Sol` 返回 404。脚本按任务书允许的
替代路径处理：markdown 用已有 agent 的真实历史消息验证；其余功能（文件写回/条目/终端/
diff/重命名）不依赖 provider 可用性，均真实 RPC 闭环。

## 1. Markdown 富渲染（✅t19）

- 验证方式：真实自动化（历史消息渲染）+ 单测快照。
- 自动化：打开已有 agent「hello」（真实 chemflow 会话），时间线 5 条 assistant 消息经
  自写渲染器输出 `md-list` / `md-table` / `md-code-block`（真实代码块内容
  `$ chemflow app list` / `ground_state_energy`）。provider 新建回复路径因账号不可用
  未走通（脚本内置 provider 轮询 + 失败删除 + 回退，逻辑保留可复跑）。
- 单测：`tests/markdown.test.ts` 13 例（标题分级/围栏未闭合/引用/嵌套列表/GFM 表格/
  行内标记序/转义/综合回复形态）。
- 证据：`t19-01-agent-markdown.png`、`t19-02-code-block.png`。

## 2. 文件写回与条目操作（✅t19）

- 验证方式：真实自动化（真实文件系统的创建→写回→读回→重命名→删除全链）+ 冲突状态机单测。
- 自动化断言（均通过）：
  - `fs.entry.create`：头部"＋"→ 新建 `t19-edit-<ts>.md`，列表出现且
    `__automation.downloadLog` 记录 `entry_created`。
  - `fs.file.write`：预览进编辑器 → 输入 `# t19 写回验证 / hello t19` → 保存 →
    `write_saved` 记录；关闭重开（重新走 daemon 读取）内容含 `hello t19`（写回读回一致）。
  - `fs.entry.rename`：长按 → 重命名为 `t19-renamed-<ts>.md`，`entry_renamed` 记录。
  - `fs.entry.delete`：长按 → 删除（确认弹窗）→ 行消失，`entry_deleted` 记录。
- 冲突路径：真机无法稳定构造并发修改，由状态机单测覆盖
  （`tests/file-edit.test.ts` 8 例：written/conflict 三选/未 dirty 拒存/失败回 dirty）。
- 文件订阅：`fs.file.subscribe` 在协议单测覆盖（subscribe→update 推送闭环）；编辑器
  远端变更横幅 UI 依赖推送时机，归入人工/单测证据。
- 证据：`t19-05-file-created.png`、`t19-06-editor-saved.png`、`t19-07-edit-readback.png`、
  `t19-08-renamed.png`、`t19-09-deleted.png`。

## 3. diff 查看（✅t19）

- 验证方式：真实自动化（真实 git 仓库数据）+ 协议解析单测。
- 自动化：Agent 列表"改动"入口 → checkout.commits.list 返回真实 commit（短 sha/作者/
  已推送徽标）→ 展开文件列表 → 点文件 → checkout.commits.file_diff 逐行渲染
  （+0 行 / −4 行，着色断言通过）。
- 单测：`tests/diff-protocol.test.ts` 6 例（commits/diff 容错解析、坏条目剔除）。
- 证据：`t19-10-commits.png`、`t19-11-diff.png`。

## 4. 终端渲染面·适配版（✅t19）

- 验证方式：真实自动化（真实 PTY 全链）+ 基础件单测。
- 自动化断言（均通过）：
  - 工作区终端：文件页 `>_` 入口 → create_terminal → subscribe_terminal
    （visible-snapshot）→ Restore/Output 帧实时渲染（状态胶囊"输出中"）；
  - 输入闭环：terminal_input 发送 `echo t19-terminal-ok` → PTY 回显出现在渲染行。
  - 脚本输出入口：脚本卡"输出"按钮已接（terminalId 存在时显示）；当日该工作区无
    running 脚本，t19-13 按预案跳过（逻辑在脚本中保留）。
- 单测：`tests/terminal.test.ts` 14 例（ANSI 剥离/CR 覆盖/退格/行数上限/帧编解码）。
- 证据：`t19-12-terminal-output.png`。

## 5. Subagents 轨道（✅t19）

- 验证方式：真实自动化（RPC + 面板）+ 协议单测。
- 自动化：详情页"子代理"按钮 → 面板打开（provider_subagents.list 真实往返；该 agent
  暂无子代理，空态文案展示）。upsert/remove 推送闭环由
  `tests/protocol-t19.test.ts` 覆盖。
- 证据：`t19-04-subagents.png`。

## 6. 斜杠命令（✅t19）

- 验证方式：真实自动化（RPC 往返）+ 协议单测。
- 自动化：composer 输入 "/" → list_commands 真实往返完成（automation log
  `slash_commands count:0`）——daemon 现网该 agent 命令目录为空，面板不弹属预期
  （面板出现条件为目录非空）。非空目录的面板交互（前缀过滤/点按填充）由
  `tests/protocol-t19.test.ts` 的 listCommands 解析路径支撑。
- 证据：`t19-03-slash-commands-empty.png`。

## 7. P2 项

- 重命名（✅t19）：真实自动化——update_agent name 改为 `t19验证-<ts>`（导航栏同步
  更新）后还原原名，不留副作用。证据 `t19-04b-agent-renamed.png`。
- worktree 隔离创建选项（✅t19）：创建页开关 + 新分支名输入 → create_agent
  `worktree: {mode:"branch-off"}`。协议层真实报文由单测断言；真机创建因 provider
  账号不可用无法走通分支创建链路（依赖 daemon git 环境 + provider 会话），矩阵注明。
- 会话导出（✅t19）：真实自动化——"导出"按钮 → 时间线 markdown 进剪贴板
  （getClipboardData 断言含 `# ` 标题）。
- activeTurnBehavior（✅t19）：运行中"发送:插入/打断"toggle；报文字段由
  协议单测断言（UI 交互依赖 running 态，本轮 provider 不可用未触发实机展示）。
- 上下文计量条（✅t19）：lastUsage 驱动（agent_update 全量推送提供）；真机该 agent
  未推送 usage（provider 不可用，无用量产生），渲染条件由代码与协议解析单测保障。

## 8. 门禁结果

- `npm run typecheck`：通过（app + test 两个 tsconfig）。
- `npx vitest run`：218 通过 / 1 跳过（既有 15 套件 + t19 新增 5 套件），无回归。
- `npm run build:weapp`：编译成功；`dist` 总量 876KB（主包，无分包），远低于 2MB 上限
  （t18 基线约 800KB 量级，markdown 渲染器 + 终端 + diff + 编辑器增量约 70KB）。
- `git log` 干净（见提交记录，逐路径暂存自查）。

## 9. 遗留与建议

- daemon provider 账号恢复后，建议复跑 `scripts/ui-automation-t19.mjs`：markdown 的
  新建回复路径与 worktree 创建实机链路会自动走 provider 轮询分支补齐证据。
- 验收脚本每轮会在 daemon 侧遗留 1 个工作区终端 PTY（create_terminal 无 kill 入口，
  本次未 vendor kill_terminal；建议 t20 补"终端关闭/kill"）。
- t20 建议批次（3 项管理面 + 1 小项）：项目设置/工作区归档、集成设置+诊断导出、
  MCP 服务器管理、kill_terminal/终端关闭。⏸ 项（订阅消息模板、语音听写）独立评估。
