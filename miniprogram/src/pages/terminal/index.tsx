/**
 * 简化终端视图（t19）：terminalId → subscribe_terminal（visible-snapshot 回放）
 * → TerminalStream 二进制帧（Restore=ANSI 文本 / Output=增量 / Snapshot=grid cells）
 * → utils/terminal-buffer 剥 ANSI 累积纯文本行 + 输入条（terminal_input）。
 *
 * 入口：脚本页"输出"（脚本 terminalId）；文件页头部"终端"（create_terminal）。
 * 适配取舍（对照 app 的 xterm 全渲染）：无 ANSI 着色（纯文本）、无光标定位、
 * 行宽 200 字符 + 500 行上限；输入按行发送（追加换行）。
 */

import { useEffect, useRef, useState } from "react";
import { useLoad } from "@tarojs/taro";
import { Button, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { TerminalStreamOpcode, type TerminalStreamFrame } from "@/connection/terminal-frames";
import { decodeUtf8 } from "@/connection/utf8";
import { TerminalBuffer } from "@/utils/terminal-buffer";
import { useThemeClass } from "@/hooks/use-theme";
import "./index.css";

/** cell → 单字符（TerminalCellSchema.char；异常 cell 归空串）。 */
function cellChar(cell: unknown): string {
  if (typeof cell === "object" && cell !== null && "char" in cell) {
    const char = (cell as { char?: unknown }).char;
    return typeof char === "string" ? char : "";
  }
  return "";
}

/** Snapshot 帧 payload（TerminalState）→ 文本行（grid + scrollback cells 取 char）。 */
function snapshotToLines(payload: Uint8Array): string[] | null {
  try {
    const state = JSON.parse(decodeUtf8(payload)) as {
      grid?: unknown;
      scrollback?: unknown;
    };
    const rowsToText = (rows: unknown): string[] =>
      Array.isArray(rows)
        ? rows.map((row) => (Array.isArray(row) ? row.map(cellChar).join("") : ""))
        : [];
    const scrollback = rowsToText(state.scrollback);
    const grid = rowsToText(state.grid);
    return [...scrollback, ...grid];
  } catch {
    return null;
  }
}

interface TerminalViewLine {
  id: number;
  text: string;
}

export default function TerminalPage() {
  const themeClass = useThemeClass();
  const [terminalId, setTerminalId] = useState("");
  const [headTitle, setHeadTitle] = useState("");
  const [lines, setLines] = useState<TerminalViewLine[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");
  const [error, setError] = useState("");
  const bufferRef = useRef(new TerminalBuffer());
  const detachRef = useRef<(() => void) | null>(null);
  const lineIdRef = useRef(0);
  const bottomAnchor = useRef(`term-bottom-${Date.now()}`);

  useLoad((options) => {
    const id = options?.terminalId ? decodeURIComponent(options.terminalId) : "";
    const title = options?.title ? decodeURIComponent(options.title) : "";
    if (id) setTerminalId(id);
    if (title) setHeadTitle(title);
  });

  useEffect(() => {
    if (!terminalId) return;
    let disposed = false;
    const conn = connectionManager.getConnection();
    if (!conn) {
      setError("未连接设备");
      return;
    }
    const buffer = bufferRef.current;
    const flush = () => {
      const next = buffer.lines().map((text) => {
        lineIdRef.current += 1;
        return { id: lineIdRef.current, text };
      });
      setLines(next);
      bottomAnchor.current = `term-bottom-${Date.now()}`;
    };

    const handleFrame = (frame: TerminalStreamFrame) => {
      if (disposed) return;
      if (
        frame.opcode === TerminalStreamOpcode.Output ||
        frame.opcode === TerminalStreamOpcode.Restore
      ) {
        // Restore = 回放（ANSI 文本）；Output = 增量。均走 ANSI 剥离缓冲。
        buffer.push(decodeUtf8(frame.payload));
        flush();
        return;
      }
      if (frame.opcode === TerminalStreamOpcode.Snapshot) {
        const snapshot = snapshotToLines(frame.payload);
        if (snapshot) {
          buffer.reset();
          buffer.push(snapshot.join("\n"));
          flush();
        }
      }
    };

    const unsubscribeExit = connectionManager.onTerminalExit((payload) => {
      if (payload.terminalId !== terminalId || disposed) return;
      setStatus("closed");
      if (payload.error) setError(`观察结束：${payload.error}`);
    });

    void (async () => {
      try {
        const handle = await conn.subscribeTerminal(terminalId, handleFrame, {
          scrollbackLines: 300,
        });
        if (disposed) {
          handle.detach();
          return;
        }
        detachRef.current = handle.detach;
        setStatus("live");
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("closed");
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribeExit();
      detachRef.current?.();
      detachRef.current = null;
    };
  }, [terminalId]);

  const sendLine = () => {
    const text = draft;
    if (!text || !terminalId) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    conn.sendTerminalInput(terminalId, { type: "input", data: `${text}\n` });
    // 本地回显（简化：PTY 多半也会回显，剥 ANSI 后通常重复一次；可接受）
    bufferRef.current.push(`${text}\n`);
    const next = bufferRef.current.lines().map((t) => {
      lineIdRef.current += 1;
      return { id: lineIdRef.current, text: t };
    });
    setLines(next);
    setDraft("");
    bottomAnchor.current = `term-bottom-${Date.now()}`;
  };

  return (
    <View className={`page terminal-page ${themeClass}`}>
      <View className="term-head">
        <View className="term-title">{headTitle || "终端"}</View>
        <View
          className={`term-pill ${
            status === "live" ? "term-pill-live" : status === "closed" ? "term-pill-closed" : ""
          }`}
        >
          {status === "connecting" ? "连接中" : status === "live" ? "输出中" : "已结束"}
        </View>
      </View>
      {error ? <View className="error-inline term-error">{error}</View> : null}
      <ScrollView
        className="term-body"
        scrollY
        enhanced
        showScrollbar={false}
        scrollIntoView={bottomAnchor.current}
      >
        <ScrollView className="term-lines-scroll" scrollX enhanced showScrollbar={false}>
          <View className="term-lines">
            {lines.length === 0 ? (
              <View className="faint term-empty">暂无输出…</View>
            ) : (
              lines.map((line) => (
                <View key={line.id} className="term-line num">
                  {line.text || " "}
                </View>
              ))
            )}
            <View id={bottomAnchor.current} />
          </View>
        </ScrollView>
      </ScrollView>
      <View className="term-input-row">
        <Input
          className="term-input"
          value={draft}
          onInput={(e) => setDraft(e.detail.value)}
          onConfirm={() => sendLine()}
          placeholder={status === "live" ? "输入后发送到终端…" : "终端未在输出"}
          placeholderClass="composer-placeholder"
          confirmType="send"
          confirmHold
          disabled={status !== "live"}
        />
        <Button
          className={`btn send-btn ${draft && status === "live" ? "send-ready" : ""}`}
          disabled={!draft || status !== "live"}
          onClick={() => sendLine()}
        >
          发送
        </Button>
      </View>
    </View>
  );
}
