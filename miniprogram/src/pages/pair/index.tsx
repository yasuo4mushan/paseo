import { useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Textarea, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import "./index.css";

export default function PairPage() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const doConnect = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("请输入配对链接");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await connectionManager.connect(trimmed);
      Taro.switchTab({ url: "/pages/agents/index" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onScan = () => {
    Taro.scanCode({
      onlyFromCamera: false,
      scanType: ["qrCode"],
      success: (res) => {
        const scanned = res.result?.trim();
        if (scanned) {
          setInput(scanned);
          void doConnect(scanned);
        }
      },
      fail: () => {
        setError("扫码取消或失败");
      },
    });
  };

  return (
    <View className="page">
      <View className="card">
        <View className="section-title">连接你的 Paseo</View>
        <View className="muted tip">
          粘贴 daemon 输出的 relay:// 配对链接（等同密码，请勿转发），或扫描二维码。
          开发调试也可以直接填 ws:// 地址。
        </View>
        <Textarea
          className="pair-input"
          value={input}
          onInput={(e) => setInput(e.detail.value)}
          placeholder="relay://host:port/serverId?key=..."
          maxlength={2000}
          autoHeight
        />
        {error ? <View className="pair-error">{error}</View> : null}
        <Button
          className="button"
          disabled={busy}
          loading={busy}
          onClick={() => void doConnect(input)}
        >
          {busy ? "连接中…" : "连接"}
        </Button>
        <Button className="button button-secondary scan-btn" disabled={busy} onClick={onScan}>
          扫二维码
        </Button>
      </View>
      <View className="card">
        <View className="muted">
          安全说明：中继模式端到端加密（X25519 + XSalsa20-Poly1305），中继服务器只能看到密文。
        </View>
      </View>
    </View>
  );
}
