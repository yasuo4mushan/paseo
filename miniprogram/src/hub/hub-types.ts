/**
 * Hub API 类型与防御式解析守卫。
 *
 * 契约（t12 hub 服务实现）：
 * - 传输：`POST <base>/<method>`，JSON body；响应 `{ok:true,data}` / `{ok:false,error:{code,message}}`。
 * - auth.register {username,password} → {account:{id,username}}
 * - auth.login {username,password} → {token,account}
 * - auth.logout / auth.me → {account}
 * - devices.list → {devices:[{deviceId,name,os,online,lastSeenAt,offer:{...}|null}]}
 *
 * 解析策略与 protocol-types.ts 一致：只取认识的字段、形态不对的条目丢弃，
 * 保证 hub 后续加字段不破坏旧客户端。
 */

export interface HubAccount {
  id: string;
  username: string;
}

/** devices.list 返回的设备连接 offer（形态与 relay:// URI 解析结果一致）。 */
export interface HubDeviceOffer {
  serverId: string;
  daemonPublicKeyB64: string;
  endpoint: string; // host:port
  useTls: boolean;
}

export interface HubDevice {
  deviceId: string;
  name: string;
  os: string; // darwin / linux / win32 / 任意字符串
  online: boolean;
  lastSeenAt: string; // ISO 时间，可能为空串
  offer: HubDeviceOffer | null; // 离线或未配对的设备没有 offer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseHubAccount(value: unknown): HubAccount | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const username = str(value.username);
  if (!id || !username) return null;
  return { id, username };
}

export function parseHubDeviceOffer(value: unknown): HubDeviceOffer | null {
  if (!isRecord(value)) return null;
  const serverId = str(value.serverId);
  const daemonPublicKeyB64 = str(value.daemonPublicKeyB64);
  const endpoint = str(value.endpoint);
  if (!serverId || !daemonPublicKeyB64 || !endpoint) return null;
  return { serverId, daemonPublicKeyB64, endpoint, useTls: value.useTls === true };
}

export function parseHubDevice(value: unknown): HubDevice | null {
  if (!isRecord(value)) return null;
  const deviceId = str(value.deviceId);
  if (!deviceId) return null;
  return {
    deviceId,
    name: str(value.name) ?? deviceId,
    os: str(value.os) ?? "",
    online: value.online === true,
    lastSeenAt: str(value.lastSeenAt) ?? "",
    offer: parseHubDeviceOffer(value.offer),
  };
}

export function parseHubDevices(value: unknown): HubDevice[] {
  const raw = isRecord(value) && Array.isArray(value.devices) ? value.devices : [];
  return raw
    .map((entry) => parseHubDevice(entry))
    .filter((device): device is HubDevice => device !== null);
}
