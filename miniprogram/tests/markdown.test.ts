/**
 * t19 Markdown 解析器单测：块级结构 + 行内标记 + 快照（AST 结构断言）。
 */

import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, spansToText } from "../src/utils/markdown";

describe("parseInline", () => {
  it("纯文本原样通过", () => {
    expect(parseInline("hello world")).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("行内码优先（内部标记不展开）", () => {
    expect(parseInline("`a*b`")).toEqual([{ kind: "code", text: "a*b" }]);
  });

  it("粗体/斜体/删除线", () => {
    expect(parseInline("**bold**")).toEqual([{ kind: "strong", text: "bold" }]);
    expect(parseInline("*it*")).toEqual([{ kind: "em", text: "it" }]);
    expect(parseInline("_it_")).toEqual([{ kind: "em", text: "it" }]);
    expect(parseInline("~~gone~~")).toEqual([{ kind: "strike", text: "gone" }]);
  });

  it("方括号链接与裸链接", () => {
    expect(parseInline("[文本](https://a.dev/x)")).toEqual([
      { kind: "link", text: "文本", href: "https://a.dev/x" },
    ]);
    expect(parseInline("看 https://a.dev 吧")).toEqual([
      { kind: "text", text: "看 " },
      { kind: "link", text: "https://a.dev", href: "https://a.dev" },
      { kind: "text", text: " 吧" },
    ]);
  });

  it("转义符按文本消费", () => {
    expect(spansToText(parseInline("\\*不是斜体\\*"))).toBe("*不是斜体*");
  });

  it("混合序列切分", () => {
    const spans = parseInline("前 **中** `码` 尾");
    expect(spans.map((s) => s.kind)).toEqual(["text", "strong", "text", "code", "text"]);
  });
});

describe("parseMarkdown 块级", () => {
  it("标题分级", () => {
    const blocks = parseMarkdown("# 一级\n\n### 三级");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, spans: [{ kind: "text", text: "一级" }] },
      { kind: "heading", level: 3, spans: [{ kind: "text", text: "三级" }] },
    ]);
  });

  it("代码围栏（语言 + 未闭合兜底）", () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\nconst b = "x";\n```');
    expect(blocks).toEqual([
      { kind: "code", lang: "ts", code: 'const a = 1;\nconst b = "x";', closed: true },
    ]);
    const unclosed = parseMarkdown("```\nabc");
    expect(unclosed).toEqual([{ kind: "code", lang: "", code: "abc", closed: false }]);
  });

  it("引用与引用内段落", () => {
    const blocks = parseMarkdown("> 引用一\n> 引用二\n\n正文");
    expect(blocks[0].kind).toBe("quote");
    if (blocks[0].kind === "quote") {
      expect(blocks[0].blocks).toEqual([
        {
          kind: "paragraph",
          spans: [{ kind: "text", text: "引用一 引用二" }],
        },
      ]);
    }
    expect(blocks[1].kind).toBe("paragraph");
  });

  it("无序/有序列表与嵌套缩进", () => {
    const blocks = parseMarkdown("- a\n- b\n  - b1\n1. one\n2. two");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { spans: [{ kind: "text", text: "a" }], indent: 0 },
          { spans: [{ kind: "text", text: "b" }], indent: 0 },
          { spans: [{ kind: "text", text: "b1" }], indent: 1 },
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          { spans: [{ kind: "text", text: "one" }], indent: 0 },
          { spans: [{ kind: "text", text: "two" }], indent: 0 },
        ],
      },
    ]);
  });

  it("GFM 表格", () => {
    const blocks = parseMarkdown("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    expect(blocks).toEqual([
      {
        kind: "table",
        header: [[{ kind: "text", text: "列A" }], [{ kind: "text", text: "列B" }]],
        rows: [[[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]]],
      },
    ]);
  });

  it("分隔线与空输入", () => {
    expect(parseMarkdown("a\n---\nb")[1]).toEqual({ kind: "hr" });
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseMarkdown 综合（assistant 回复形态快照）", () => {
  it("典型代码回复", () => {
    const reply = [
      "## 修改说明",
      "",
      "改了 `foo()` 的两处：",
      "",
      "1. 参数校验前移",
      "2. **返回值**改为 `Promise<void>`",
      "",
      "```python",
      "async def foo(x: int) -> None:",
      "    if x < 0:",
      "        raise ValueError('x must be >= 0')",
      "```",
      "",
      "详见 [文档](https://example.dev/docs)。",
    ].join("\n");
    const blocks = parseMarkdown(reply);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "paragraph",
    ]);
    const code = blocks[3];
    if (code.kind !== "code") throw new Error("unreachable");
    expect(code.lang).toBe("python");
    expect(code.code).toContain("raise ValueError");
    const tail = blocks[4];
    if (tail.kind !== "paragraph") throw new Error("unreachable");
    expect(tail.spans.some((s) => s.kind === "link" && s.href === "https://example.dev/docs")).toBe(
      true,
    );
  });
});
