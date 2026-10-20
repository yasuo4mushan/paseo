/**
 * relay:// 配对 URI 解析与 relay WebSocket URL 构造。
 *
 * Vendor/适配自 packages/protocol/src/daemon-endpoints.ts 的
 * parseRelayConnectionUri / buildRelayWebSocketUrl。差异：微信小程序运行时
 * 没有 WHATWG URL 类，改用正则手工解析（tests/offer-parse.test.ts 用 Node
 * URL 做行为一致性校验）。
 *
 * URI 形态：relay://host:port/<serverId>?key=<daemon公钥 base64 URL 编码>[&ssl=true][&password=...]
 * 兼容 `https://...#connect=<encodeURIComponent(relay://...)>` 包装。
 */

export interface RelayOffer {
  serverId: string;
  daemonPublicKeyB64: string;
  endpoint: string; // host:port
  useTls: boolean;
  password?: string;
}

const RELAY_URI_PATTERN = /^relay:\/\/([^/:?#\s]+):(\d{1,5})/;

function decodeQueryParam(value: string): string {
  // URLSearchParams 的解码语义：+ 表示空格，%XX 百分号解码
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!query) return out;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      out.set(decodeQueryParam(pair), "");
      continue;
    }
    out.set(decodeQueryParam(pair.slice(0, eq)), decodeQueryParam(pair.slice(eq + 1)));
  }
  return out;
}

export function parseRelayOffer(input: string): RelayOffer {
  let uri = input.trim();
  if (!uri) throw new Error("无效的配对链接");

  // https://app.example/#connect=<encoded relay uri>
  const connectIndex = uri.indexOf("#connect=");
  if (connectIndex >= 0) {
    uri = decodeURIComponent(uri.slice(connectIndex + "#connect=".length)).trim();
  }

  const match = RELAY_URI_PATTERN.exec(uri);
  if (!match) throw new Error("无效的 relay 配对链接（应为 relay://host:port/serverId?key=...）");

  const host = match[1];
  const port = Number(match[2]);
  const rest = uri.slice(match[0].length);

  const queryIndex = rest.indexOf("?");
  const pathPart = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const query = parseQuery(queryIndex >= 0 ? rest.slice(queryIndex + 1) : "");

  const serverId = decodeQueryParam(pathPart.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!serverId || serverId.includes("/")) {
    throw new Error("relay 配对链接缺少 serverId");
  }

  const key = query.get("key");
  if (!key) throw new Error("relay 配对链接缺少 daemon 公钥（key 参数）");

  const password = query.get("password") || undefined;

  return {
    serverId,
    daemonPublicKeyB64: key,
    endpoint: `${host}:${port}`,
    useTls: query.get("ssl") === "true",
    ...(password ? { password } : {}),
  };
}

export interface RelayClientUrlParams {
  offer: RelayOffer;
}

/** 构造 relay v2 客户端连接 URL。connectionId 由 relay 分配（客户端不传）。 */
export function buildRelayClientWebSocketUrl({ offer }: RelayClientUrlParams): string {
  const protocol = offer.useTls ? "wss" : "ws";
  const serverId = encodeURIComponent(offer.serverId);
  return `${protocol}://${offer.endpoint}/ws?serverId=${serverId}&v=2&role=client`;
}

/** 判断输入是否为可识别的配对输入（relay URI / #connect= / 直连 ws URL）。 */
export function parseConnectionInput(
  input: string,
): { kind: "relay"; offer: RelayOffer } | { kind: "direct"; url: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入配对链接或 WebSocket 地址");
  if (trimmed.startsWith("relay://") || trimmed.includes("#connect=")) {
    return { kind: "relay", offer: parseRelayOffer(trimmed) };
  }
  if (/^wss?:\/\/\S+$/.test(trimmed)) {
    return { kind: "direct", url: trimmed };
  }
  throw new Error("无法识别的输入：支持 relay:// 配对链接或 ws(s):// 直连地址");
}
