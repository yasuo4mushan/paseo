import { useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, View } from "@tarojs/components";
import { hub, hubErrorMessage, hasSession } from "@/hub/hub-client";
import { useThemeClass } from "@/hooks/use-theme";
import "./index.css";

type Mode = "login" | "register";

export default function LoginPage() {
  const themeClass = useThemeClass();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 已有会话时直接进入设备页（例如退出登录后误触返回）
  useEffect(() => {
    if (hasSession()) {
      Taro.switchTab({ url: "/pages/devices/index" });
    }
  }, []);

  const validate = (): string => {
    if (username.trim().length < 2) return "用户名至少 2 个字符";
    if (password.length < 6) return "密码至少 6 位";
    return "";
  };

  const submit = async () => {
    if (busy) return;
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        await hub.register(username, password);
      } else {
        await hub.login(username, password);
      }
      Taro.switchTab({ url: "/pages/devices/index" });
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
  };

  return (
    <View className={`login-page ${themeClass}`}>
      <View className="login-hero">
        <View className="brand-word">
          <View className="brand-aa">aa</View>
          <View className="brand-switch">switch</View>
        </View>
        <View className="brand-tagline">你的 AI 编码代理，随身掌控</View>
      </View>

      <View className="login-card">
        <View className="field">
          <View className="field-label">用户名</View>
          <Input
            className="field-input login-username"
            value={username}
            onInput={(e) => setUsername(e.detail.value)}
            placeholder="2-32 位字母数字下划线"
            placeholderClass="input-placeholder"
            maxlength={32}
          />
        </View>
        <View className="field">
          <View className="field-label">密码</View>
          <Input
            className="field-input login-password"
            value={password}
            onInput={(e) => setPassword(e.detail.value)}
            placeholder="至少 6 位"
            placeholderClass="input-placeholder"
            password
            maxlength={64}
            onConfirm={() => void submit()}
          />
        </View>
        {error ? <View className="field-error login-error">{error}</View> : null}
        <Button
          className="btn btn-login"
          disabled={busy}
          loading={busy}
          onClick={() => void submit()}
        >
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
        </Button>
        <View
          className="login-switch"
          onClick={() => switchMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "没有账号？注册一个" : "已有账号？直接登录"}
        </View>
      </View>

      <View className="footer-note">
        连接端到端加密，密钥只保存在你的设备上
        {"\n"}aaswitch · based on Paseo
      </View>
    </View>
  );
}
