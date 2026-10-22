/**
 * 线条图标资产索引（t20）：图标一律 PNG 线条风（scripts/gen-icons.mjs 产物），
 * 不再用 emoji（跨机型渲染不一致且"太 AI"）。
 *
 * 颜色档：缺省中性灰（浅/深主题同档可用，tabBar 先例）；语义变体带后缀。
 * 使用：<Image className="icon" src={iconUrl("file")} />，尺寸由 .icon 类控制。
 */

import iconManifest from "@/assets/icons/manifest.json";

export type IconName = keyof typeof iconManifest;
export type IconVariant = "" | "-active" | "-danger" | "-warning" | "-inverse";

const cache = new Map<string, string>();

export function iconUrl(name: IconName, variant: IconVariant = ""): string {
  const key = `${name}${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const entry = iconManifest[name] as { files: string[] } | undefined;
  const file = entry?.files.find((f) => f === `${key}.png`);
  // 生成器 manifest 与资产文件同源；找不到属构建期错误，回落基础名避免运行时崩
  const url = file ? `/assets/icons/${file}` : `/assets/icons/${name}.png`;
  cache.set(key, url);
  return url;
}

/** agent provider → 品牌标（未收录 provider 回退会话气泡）。 */
const BRAND_ICONS: Record<string, IconName> = {
  claude: "brand-claude",
  "claude-code": "brand-claude",
  codex: "brand-codex",
  zcode: "brand-zcode",
  kimi: "brand-kimi",
  codebuddy: "brand-codebuddy",
  qoder: "brand-qoder",
  qwen: "brand-qwen",
  opencode: "brand-codex",
};

export function providerIconUrl(provider: string): string {
  const key = provider.toLowerCase();
  const name = BRAND_ICONS[key];
  return name ? iconUrl(name) : iconUrl("chat");
}
