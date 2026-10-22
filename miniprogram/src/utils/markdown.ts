/**
 * 轻量 Markdown 解析器（t19）：时间线 assistant 消息富渲染用。
 *
 * 自写 block/inline 两级解析 → AST（纯数据），渲染在 components/markdown.tsx
 * 完成 AST→Taro View 映射。不依赖 eval 类机制，无正则安全风险面
 * （仅做字符串匹配切分）。
 *
 * 覆盖范围（对照 app 的 markdown-renderer 能力做小程序适配裁剪）：
 * - 块级：标题（# 至 ######）、代码围栏（三反引号/三波浪线，未闭合兜底）、
 *   引用（>）、无序/有序列表（- * + 与 1. 记号，最多两层缩进）、
 *   GFM 管道表格（列对齐忽略）、分隔线、段落。
 * - 行内：粗体、斜体（星号/下划线）、删除线、行内码、方括号链接、
 *   裸 http(s) 链接。行内标记不做嵌套组合（三星粗斜体解析为粗体），
 *   与 app 的完整 CommonMark 引擎有差距，矩阵已注明"可简化"。
 * - 数学/mermaid/HTML/tasklist 不支持：按原文归入代码块或段落。
 */

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "code"; lang: string; code: string; closed: boolean }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | {
      kind: "list";
      ordered: boolean;
      /** indent 0 = 顶层，1 = 一层嵌套（更深层折叠到 1）。 */
      items: Array<{ spans: InlineSpan[]; indent: number }>;
    }
  | { kind: "table"; header: InlineSpan[][]; rows: InlineSpan[][][] }
  | { kind: "hr" };

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

/** 行内标记的切分序：行内码最优先（内部不再解析标记），其后链接、粗体、斜体、删除线。 */
const INLINE_PATTERNS: Array<{ re: RegExp; make: (m: RegExpExecArray) => InlineSpan | null }> = [
  {
    // `code`（双反引号 `` `x` `` 同样匹配：成对的最短围栏）
    re: /^(`+)([\s\S]*?)\1(?!`)/,
    make: (m) => ({ kind: "code", text: m[2].replace(/^ | $/g, "") }),
  },
  {
    // [text](href) —— href 里的空白与未闭合括号排除
    re: /^\[([^\]]*)\]\(([^()\s]+)\)/,
    make: (m) => ({ kind: "link", text: m[1] || m[2], href: m[2] }),
  },
  // 裸链接（不在 markdown 链接语法里——那已在上一个分支消费）
  {
    re: /^https?:\/\/[^\s<>()[\]]+/,
    make: (m) => ({ kind: "link", text: m[0], href: m[0] }),
  },
  {
    // ***both*** / ___both___ → 粗体（简化，不做粗斜复合样式）
    re: /^\*{3}([^*]+)\*{3}|^_{3}([^_]+)_{3}/,
    make: (m) => ({ kind: "strong", text: m[1] ?? m[2] ?? "" }),
  },
  {
    // **bold**
    re: /^\*\*([^*]+)\*\*(?!\*)/,
    make: (m) => ({ kind: "strong", text: m[1] }),
  },
  {
    re: /^__([^_]+)__(?!_)/,
    make: (m) => ({ kind: "strong", text: m[1] }),
  },
  {
    // *em*
    re: /^\*([^*\s][^*]*?)\*(?!\*)/,
    make: (m) => ({ kind: "em", text: m[1] }),
  },
  {
    re: /^_([^_\s][^_]*?)_(?!_)/,
    make: (m) => ({ kind: "em", text: m[1] }),
  },
  {
    // ~~strike~~
    re: /^~~([^~]+)~~/,
    make: (m) => ({ kind: "strike", text: m[1] }),
  },
];

/** 解析一行内的行内标记 → span 序列。空行返回空数组。 */
export function parseInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = "";
  let rest = line;
  const flush = () => {
    if (buffer) {
      spans.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };
  while (rest.length > 0) {
    const ch = rest[0];
    if (ch === "`" || ch === "[" || ch === "*" || ch === "_" || ch === "~" || ch === "h") {
      let matched = false;
      for (const pattern of INLINE_PATTERNS) {
        const m = pattern.re.exec(rest);
        if (!m) continue;
        const span = pattern.make(m);
        if (!span) continue;
        flush();
        spans.push(span);
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
      if (matched) continue;
    }
    // 转义符：下一个字符按纯文本消费（\* 等）
    if (ch === "\\" && rest.length > 1) {
      buffer += rest[1];
      rest = rest.slice(2);
      continue;
    }
    buffer += ch;
    rest = rest.slice(1);
  }
  flush();
  return spans;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_ITEM_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;

function indentLevel(spaces: string): number {
  if (spaces.length >= 4) return 1;
  if (spaces.length >= 2) return 1;
  return 0;
}

/** GFM 表格行切分：| a | b | → ["a","b"]（首尾空管道剔除，单元格内 \| 保留）。 */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** 分隔行判定：| --- | :---: | 形态（至少一列，内容只含 :- 空格）。 */
function isTableDelimiter(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell) && cell.includes("-"));
}

/** 收集引用体（去前缀后的行）→ 递归块解析（引用内允许标题/列表/代码块简化为段落级）。 */
function parseQuoteContent(lines: string[]): MarkdownBlock[] {
  return parseBlocks(lines);
}

/**
 * 块级解析主入口。lines 是原始行（未去 \r——调用前统一处理）。
 */
export function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // 代码围栏
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const markerLen = fence[1].length;
      const lang = fence[2] ?? "";
      const codeLines: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const body = lines[i];
        const closeMatch = new RegExp(`^ {0,3}\\${marker}{${markerLen},}\\s*$`).exec(body);
        if (closeMatch) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(body);
        i += 1;
      }
      blocks.push({ kind: "code", lang, code: codeLines.join("\n"), closed });
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: "heading", level, spans: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }

    // 分隔线
    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    // 引用（连续引用行归并）
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const quoted: string[] = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE_RE.exec(lines[i]);
        if (!next) {
          // 懒延续：空行终止；非空非引用行也终止（不做段落延续合并）
          break;
        }
        quoted.push(next[1]);
        i += 1;
      }
      blocks.push({ kind: "quote", blocks: parseQuoteContent(quoted) });
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(line).map((cell) => parseInline(cell));
      i += 2;
      const rows: InlineSpan[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // 列表（连续项归并；类型以首项为准，异类型项终止当前列表由外层再起一段）
    const ul = UL_ITEM_RE.exec(line);
    const ol = ul ? null : OL_ITEM_RE.exec(line);
    if (ul || ol) {
      const ordered = ol !== null;
      const itemRe = ordered ? OL_ITEM_RE : UL_ITEM_RE;
      const items: Array<{ spans: InlineSpan[]; indent: number }> = [];
      while (i < lines.length) {
        const itemLine = lines[i];
        const itemMatch = itemRe.exec(itemLine);
        if (!itemMatch) {
          // 懒延续：缩进 ≥2 空格的非空行并入上一项（多行项简化为空格拼接）
          if (itemLine.trim() !== "" && /^\s{2,}\S/.test(itemLine) && items.length > 0) {
            items[items.length - 1].spans.push({ kind: "text", text: ` ${itemLine.trim()}` });
            i += 1;
            continue;
          }
          break;
        }
        const indent = indentLevel(itemMatch[1]);
        const text = itemMatch[3] ?? "";
        items.push({ spans: parseInline(text.trim()), indent });
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // 段落：连续非空、非块起始行归并
    const paraLines: string[] = [];
    while (i < lines.length) {
      const body = lines[i];
      if (
        body.trim() === "" ||
        HEADING_RE.test(body) ||
        HR_RE.test(body) ||
        QUOTE_RE.test(body) ||
        FENCE_RE.test(body) ||
        UL_ITEM_RE.test(body) ||
        OL_ITEM_RE.test(body)
      ) {
        break;
      }
      paraLines.push(body.trim());
      i += 1;
    }
    if (paraLines.length > 0) {
      const spans = parseInline(paraLines.join(" "));
      if (spans.length > 0) blocks.push({ kind: "paragraph", spans });
    }
  }

  return blocks;
}

/** 解析入口：统一换行后做块级解析。 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n");
  return parseBlocks(normalized.split("\n"));
}

/** 纯文本化（复制/摘要用）：span 序列 → 字符串。 */
export function spansToText(spans: InlineSpan[]): string {
  return spans.map((span) => span.text).join("");
}
