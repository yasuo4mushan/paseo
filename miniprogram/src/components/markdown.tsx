/**
 * Markdown 渲染组件（t19）：utils/markdown.ts 的 AST → Taro View 映射。
 *
 * 与 app 的 react-native-enriched-markdown（原生引擎）不同，小程序端用
 * 自写轻量渲染：块级 View + 行内嵌套 Text。代码块等宽字体 + 横向滚动 +
 * 复制按钮；链接点按弹出"复制 / 浏览器打开"操作单（小程序无外链直跳）。
 */

import { useMemo } from "react";
import Taro from "@tarojs/taro";
import { ScrollView, Text, View } from "@tarojs/components";
import { parseMarkdown, type InlineSpan, type MarkdownBlock } from "@/utils/markdown";
import "./markdown.css";

function SpanText({ span }: { span: InlineSpan }) {
  switch (span.kind) {
    case "strong":
      return <Text className="md-strong">{span.text}</Text>;
    case "em":
      return <Text className="md-em">{span.text}</Text>;
    case "strike":
      return <Text className="md-strike">{span.text}</Text>;
    case "code":
      return <Text className="md-code-inline">{span.text}</Text>;
    case "link":
      return (
        <Text className="md-link" onClick={() => openLink(span.href)}>
          {span.text}
        </Text>
      );
    default:
      return <Text>{span.text}</Text>;
  }
}

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <Text className="md-inline" userSelect>
      {spans.map((span, i) => (
        <SpanText key={i} span={span} />
      ))}
    </Text>
  );
}

/** 链接交互：复制到剪贴板 + 提示在浏览器打开（小程序限制无外链跳转）。 */
function openLink(href: string) {
  void Taro.showModal({
    title: "链接",
    content: href,
    confirmText: "复制",
    cancelText: "取消",
    success: (res) => {
      if (!res.confirm) return;
      void Taro.setClipboardData({ data: href }).then(() =>
        Taro.showToast({ title: "链接已复制", icon: "none" }),
      );
    },
  });
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const copy = () => {
    void Taro.setClipboardData({ data: code }).then(() =>
      Taro.showToast({ title: "代码已复制", icon: "none" }),
    );
  };
  return (
    <View className="md-code-block">
      <View className="md-code-head">
        <Text className="md-code-lang num">{lang || "code"}</Text>
        <View className="md-code-copy" onClick={copy}>
          复制
        </View>
      </View>
      <ScrollView className="md-code-body" scrollX enhanced showScrollbar={false}>
        <Text className="md-code-text num" userSelect>
          {code || " "}
        </Text>
      </ScrollView>
    </View>
  );
}

function BlockView({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "heading": {
      const cls = `md-heading md-h${block.level}`;
      return (
        <View className={cls}>
          <Spans spans={block.spans} />
        </View>
      );
    }
    case "paragraph":
      return (
        <View className="md-para">
          <Spans spans={block.spans} />
        </View>
      );
    case "code":
      return <CodeBlock lang={block.lang} code={block.code} />;
    case "quote":
      return (
        <View className="md-quote">
          {block.blocks.map((child, i) => (
            <BlockView key={i} block={child} />
          ))}
        </View>
      );
    case "list":
      return (
        <View className="md-list">
          {block.items.map((item, i) => (
            <View key={i} className={`md-item md-item-${item.indent}`}>
              <Text className="md-item-marker">{block.ordered ? `${i + 1}.` : "•"}</Text>
              <View className="md-item-body">
                <Spans spans={item.spans} />
              </View>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView className="md-table-scroll" scrollX enhanced showScrollbar={false}>
          <View className="md-table">
            <View className="md-tr md-tr-head">
              {block.header.map((cell, i) => (
                <View key={i} className="md-td">
                  <Spans spans={cell} />
                </View>
              ))}
            </View>
            {block.rows.map((row, r) => (
              <View key={r} className="md-tr">
                {row.map((cell, c) => (
                  <View key={c} className="md-td">
                    <Spans spans={cell} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "hr":
      return <View className="md-hr" />;
    default:
      return null;
  }
}

/** 单条 assistant 消息的 Markdown 渲染。解析结果按内容 memo。 */
export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View className="md-root">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </View>
  );
}
