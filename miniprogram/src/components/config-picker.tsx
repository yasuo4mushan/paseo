/**
 * 配置选择器半屏 sheet（t20 composer 四 pill 的弹层）：
 * provider / 模型 / thinking 档位 / 审批模式 共用一份列表 UI。
 *
 * 交互：遮罩点击关闭；当前项高亮（check-active）；provider 品牌标。
 */

import { Image, ScrollView, View } from "@tarojs/components";
import { iconUrl, providerIconUrl } from "@/utils/icons";
import type { PillView } from "@/utils/composer-config";
import "./config-picker.css";

export function ConfigPickerSheet({
  visible,
  title,
  pill,
  onClose,
  onSelect,
}: {
  visible: boolean;
  title: string;
  pill: PillView | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  if (!visible || !pill) return null;
  return (
    <View className="cp-mask" onClick={onClose} catchMove>
      <View className="cp-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="cp-head">
          <View className="cp-title">{title}</View>
          <View className="cp-close" onClick={onClose}>
            <Image className="icon" src={iconUrl("close")} />
          </View>
        </View>
        <ScrollView className="cp-list" scrollY enhanced showScrollbar={false}>
          {pill.options.length === 0 ? (
            <View className="cp-empty">目录为空</View>
          ) : (
            pill.options.map((option) => {
              const selected = option.id === pill.selectedId;
              return (
                <View
                  key={option.id}
                  className={`cp-row ${selected ? "cp-row-active" : ""}`}
                  onClick={() => {
                    onSelect(option.id);
                    onClose();
                  }}
                >
                  {pill.key === "provider" ? (
                    <Image className="icon" src={providerIconUrl(option.id)} />
                  ) : null}
                  <View className="cp-main">
                    <View className="cp-label">{option.label}</View>
                    {option.description ? (
                      <View className="cp-desc">{option.description}</View>
                    ) : null}
                  </View>
                  {selected ? (
                    <Image className="icon icon-sm" src={iconUrl("check", "-active")} />
                  ) : null}
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
}
