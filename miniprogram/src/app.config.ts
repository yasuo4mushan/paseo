export default defineAppConfig({
  pages: [
    "pages/devices/index",
    "pages/login/index",
    "pages/agents/index",
    "pages/agent/index",
    "pages/create/index",
    "pages/pair/index",
    "pages/settings/index",
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
