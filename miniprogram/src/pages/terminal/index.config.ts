import { TERM_BG_COLOR } from "@/constants/colors";

export default definePageConfig({
  navigationBarTitleText: "终端",
  // 终端是恒暗表面：导航/窗口背景固定深色，不随主题翻转（t22 收口到 colors.ts）
  navigationBarBackgroundColor: TERM_BG_COLOR,
  navigationBarTextStyle: "white",
  backgroundColor: TERM_BG_COLOR,
});
