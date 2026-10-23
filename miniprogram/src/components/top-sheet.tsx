/**
 * 顶部下拉弹窗壳（t21）：对话页选择体系的统一交互语言——遮罩 + 顶部滑下面板
 * （与底部 cp-sheet 半屏 sheet 对称）。设备选择/会话选择共用；标题行 + 关闭钮
 * + 内容插槽 + 底部快捷操作插槽。
 *
 * 深色：全部走 var(--*) tokens（页面根 .theme-dark 覆盖自动生效），无硬编码色。
 */

import type { ReactNode } from "react";
import { Image, View } from "@tarojs/components";
import { iconUrl } from "@/utils/icons";
import { useThemeClass } from "@/hooks/use-theme";
import "./top-sheet.css";

export function TopSheet({
  visible,
  title,
  onClose,
  children,
  footer = null,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部快捷操作区（可选）。 */
  footer?: ReactNode;
}) {
  const themeClass = useThemeClass();
  if (!visible) return null;
  return (
    <View className={`ts-mask ${themeClass}`} onClick={onClose} catchMove>
      <View className="ts-panel" onClick={(e) => e.stopPropagation()}>
        <View className="ts-head">
          <View className="ts-title">{title}</View>
          <View className="ts-close" onClick={onClose}>
            <Image className="icon" src={iconUrl("close")} />
          </View>
        </View>
        {children}
        {footer ? <View className="ts-footer">{footer}</View> : null}
      </View>
    </View>
  );
}
