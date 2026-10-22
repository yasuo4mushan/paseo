export default defineAppConfig({
  pages: [
    // 对话主页是默认启动页（t20：豆包式——打开即上次活跃会话/快捷输入框）
    "pages/chat/index",
    "pages/devices/index",
    "pages/login/index",
    "pages/agents/index",
    "pages/agent/index",
    "pages/create/index",
    "pages/files/index",
    "pages/changes/index",
    "pages/terminal/index",
    "pages/pair/index",
    "pages/settings/index",
    "pages/schedules/index",
    "pages/scripts/index",
    "pages/new-workspace/index",
  ],
  window: {
    backgroundTextStyle: "@bgTxtStyle",
    navigationBarBackgroundColor: "@navBgColor",
    navigationBarTitleText: "aaswitch",
    navigationBarTextStyle: "@navTxtStyle",
    backgroundColor: "@bgColor",
  },
  tabBar: {
    color: "@tabColor",
    selectedColor: "@tabSelectedColor",
    backgroundColor: "@tabBgColor",
    // 微信 darkmode 支持 borderStyle 引用 theme.json 变量；Taro 类型未跟上，局部断言
    borderStyle: "@tabBorderStyle" as "white",
    list: [
      {
        pagePath: "pages/devices/index",
        text: "设备",
        iconPath: "assets/tabbar/devices.png",
        selectedIconPath: "assets/tabbar/devices-active.png",
      },
      {
        pagePath: "pages/chat/index",
        text: "对话",
        iconPath: "assets/tabbar/chat.png",
        selectedIconPath: "assets/tabbar/chat-active.png",
      },
      {
        pagePath: "pages/settings/index",
        text: "设置",
        iconPath: "assets/tabbar/settings.png",
        selectedIconPath: "assets/tabbar/settings-active.png",
      },
    ],
  },
  darkmode: true,
  themeLocation: "theme.json",
});
