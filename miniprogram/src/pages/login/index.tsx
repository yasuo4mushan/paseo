import { useEffect, useState } from "react";
import { Button, Input, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { hasSession, hub, hubErrorMessage, normalizePhoneInput } from "@/hub/hub-client";
import { useThemeClass } from "@/hooks/use-theme";
import { safeSwitchTab } from "@/utils/navigation";
import "./index.css";

type Mode = "login" | "register";

/** 微信 getPhoneNumber 回调 e.detail 的形态（code 换手机号 / errMsg 拒绝）。 */
interface WxPhoneEvent {
  detail: {
    code?: string;
    errMsg?: string;
  };
}

export default function LoginPage() {
  const themeClass = useThemeClass();
  const [mode, setMode] = useState<Mode>("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // t27：微信一键授权按钮由远端开关控制——登录页对 auth.wx-phone 发探测
  // 请求，501/404（未启用/旧 hub）即隐藏；正式 AppID 配好前线上不会出现。
  const [wxEnabled, setWxEnabled] = useState(false);

  // 已有会话时直接进对话主页（t20 豆包式直达；例如退出登录后误触返回）
  useEffect(() => {
    if (hasSession()) {
      void safeSwitchTab("/pages/chat/index");
      return;
    }
    void hub
      .probeWxLogin()
      .then(setWxEnabled)
      .catch(() => setWxEnabled(false));
  }, []);

  const validate = (): string => {
    try {
      normalizePhoneInput(phone);
    } catch (err) {
      return err instanceof Error ? err.message : "手机号格式不正确";
    }
    if (password.length < 8) return "密码至少 8 位";
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
        await hub.register(phone, password);
      } else {
        await hub.login(phone, password);
      }
      // t20：登录即落对话主页（中心 tab，未连接设备时引导连接）
      await safeSwitchTab("/pages/chat/index");
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** 微信一键授权：拒绝（errMsg）给友好提示；code 换手机号登录。 */
  const onWxGetPhoneNumber = async (e: WxPhoneEvent) => {
    if (busy) return;
    const detail = e.detail ?? {};
    if (!detail.code) {
      // 用户拒绝授权或能力不可用：errMsg 如 "getPhoneNumber:fail user deny"
      if (detail.errMsg?.includes("deny") || detail.errMsg?.includes("cancel")) {
        setError("已取消微信授权，可选择手机号登录");
      } else {
        setError(detail.errMsg ? `微信授权失败：${detail.errMsg}` : "微信授权失败，请重试");
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await hub.wxPhoneLogin(detail.code);
      if (result.account.passwordSet === false) {
        // wx-phone 创建且未设密：引导去设置页设初密（免旧密码形态）
        Taro.showToast({ title: "登录成功", icon: "success" });
        setTimeout(() => {
          Taro.showModal({
            title: "设置密码",
            content: "你还没有设置密码，设置后可用手机号+密码登录。现在去设置？",
            confirmText: "去设置",
            cancelText: "稍后",
            success: (res) => {
              void (res.confirm
                ? Taro.switchTab({ url: "/pages/settings/index" })
                : safeSwitchTab("/pages/chat/index"));
            },
          });
        }, 600);
        return;
      }
      await safeSwitchTab("/pages/chat/index");
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
          <View className="field-label">手机号</View>
          <Input
            className="field-input login-phone"
            value={phone}
            onInput={(e) => setPhone(e.detail.value)}
            placeholder="11 位大陆手机号"
            placeholderClass="input-placeholder"
            type="number"
            maxlength={11}
          />
        </View>
        <View className="field">
          <View className="field-label">密码</View>
          <Input
            className="field-input login-password"
            value={password}
            onInput={(e) => setPassword(e.detail.value)}
            placeholder="至少 8 位"
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

        {wxEnabled ? (
          <View className="wx-login-block">
            <View className="wx-login-divider">
              <View className="wx-login-divider-line" />
              <View className="wx-login-divider-text">或</View>
              <View className="wx-login-divider-line" />
            </View>
            <Button
              className="btn btn-wx-phone"
              openType="getPhoneNumber"
              onGetPhoneNumber={(e: WxPhoneEvent) => void onWxGetPhoneNumber(e)}
              disabled={busy}
            >
              微信手机号一键登录
            </Button>
          </View>
        ) : null}
      </View>

      <View className="footer-note">
        连接端到端加密，密钥只保存在你的设备上
        {"\n"}aaswitch · based on Paseo
      </View>
    </View>
  );
}
