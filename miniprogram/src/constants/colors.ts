/**
 * wx API 侧颜色常量（t22）。
 *
 * wx.showModal / 页面 config 等原生接口只接受字符串色值，CSS 变量不可用；
 * 字面量统一收口到本文件（tests/dark-audit.test.ts 白名单），与 app.css 的
 * token 值保持同步：--danger #fa5151、--term-bg #101418。
 */

/** 危险操作确认按钮（wx.showModal confirmColor），对应 token --danger。 */
export const MODAL_DANGER_COLOR = "#fa5151";

/** 终端恒暗表面底色（页面 config 导航/窗口背景），对应 token --term-bg。 */
export const TERM_BG_COLOR = "#101418";
