/**
 * 简化终端缓冲（t19）：PTY 输出（可含 ANSI 转义）→ 可渲染纯文本行。
 *
 * 适配取舍（对照 app 的 xterm 全渲染）：
 * - ANSI 着色/光标移动序列剥离（简化为纯文本——任务书允许"基本着色可简化"）。
 * - \r 覆盖语义按"截断当前行"处理（进度条最终态正确显示；不保留被覆盖残影）。
 * - \b 退格、\t 制表（展开 2 空格）、BEL 丢弃。
 * - 行数/单行长度上限防爆内存（500 行 / 2000 字符）。
 */

const MAX_LINES = 500;
const MAX_LINE_CHARS = 2000;

/** 剥离 ANSI 转义与不可见控制字符（保留 \r \n \b 交给缓冲状态机处理）。 */
const ANSI_OR_CTRL_RE =
  /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_OR_CTRL_RE, "");
}

export class TerminalBuffer {
  private finished: string[] = [];
  private current = "";

  /** 追加一段输出（先剥 ANSI，再按控制字符走行状态机）。 */
  push(raw: string): void {
    const text = stripAnsi(raw);
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "\n") {
        this.finishLine();
        continue;
      }
      if (ch === "\r") {
        // 覆盖当前行：丢弃本行已有内容，只显示覆盖后的最终态
        this.current = "";
        continue;
      }
      if (ch === "\b") {
        this.current = this.current.slice(0, -1);
        continue;
      }
      if (ch === "\t") {
        this.current = this.appendCapped(this.current, "  ");
        continue;
      }
      this.current = this.appendCapped(this.current, ch);
    }
  }

  /** 以当前缓冲生成完整行快照（当前未换行走作为最后一行）。 */
  lines(): string[] {
    const all = this.current === "" ? [...this.finished] : [...this.finished, this.current];
    return all.slice(-MAX_LINES);
  }

  /** 是否已有任何输出（区分"尚无输出"与"空行输出"）。 */
  get hasOutput(): boolean {
    return this.finished.length > 0 || this.current !== "";
  }

  reset(): void {
    this.finished = [];
    this.current = "";
  }

  private finishLine(): void {
    if (this.finished.length >= MAX_LINES) {
      this.finished.shift();
    }
    this.finished.push(this.current);
    this.current = "";
  }

  private appendCapped(line: string, suffix: string): string {
    if (line.length >= MAX_LINE_CHARS) return line;
    return line + suffix.slice(0, Math.max(0, MAX_LINE_CHARS - line.length));
  }
}
