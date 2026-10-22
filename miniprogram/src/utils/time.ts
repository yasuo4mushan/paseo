/** ISO 时间 → HH:mm（时间线气泡角标）。 */
export function formatClock(iso: string): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 时间 → 相对时间文案（设备页"最后心跳"用）。 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  if (!iso) return "从未";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "未知";
  const delta = Math.max(0, now - time);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return iso.slice(0, 10);
}

/** ISO 时间 → MM-DD HH:mm（定时任务下次执行/执行记录用）。 */
export function formatDateTime(iso: string): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
