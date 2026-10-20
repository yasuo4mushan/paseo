export default defineAppConfig({
  pages: ["pages/pair/index", "pages/agents/index", "pages/agent/index", "pages/settings/index"],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#ffffff",
    navigationBarTitleText: "Paseo",
    navigationBarTextStyle: "black",
    backgroundColor: "#f5f6f7",
  },
  tabBar: {
    color: "#7f7f7f",
    selectedColor: "#1f6feb",
    backgroundColor: "#ffffff",
    borderStyle: "black",
    list: [
      { pagePath: "pages/agents/index", text: "Agent 列表" },
      { pagePath: "pages/settings/index", text: "设置" },
    ],
  },
});
