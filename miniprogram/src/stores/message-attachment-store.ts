/**
 * 已发送附件的本地台账（t17）。
 *
 * 协议上时间线的 user_message 条目不回传附件（官方 wire schema 无该字段），
 * 官方客户端用本地 pending submission 承载附件展示。小程序侧同思路：
 * 发送带附件的消息时按 clientMessageId 记账，渲染 user_message 气泡时回配对。
 * 匹配顺序：clientMessageId → messageId → 10 分钟内同文本的未配对条目（兜底
 * daemon 不回显幂等 id 的 provider）。
 *
 * 平台无关纯 TS；单例挂 globalThis（原因见 permission-store.ts）。
 */

export interface AttachmentCard {
  kind: "image" | "file";
  fileName: string;
  size: number;
  /** 图片附件的本地临时路径（缩略展示与 previewImage 用）。 */
  localPath?: string;
}

interface LedgerEntry {
  clientMessageId: string;
  text: string;
  sentAt: number;
  cards: AttachmentCard[];
  /** 该条已被时间线条目配对消费（防重复挂载）。 */
  consumed: boolean;
}

const TEXT_FALLBACK_WINDOW_MS = 10 * 60 * 1000;
const MAX_ENTRIES_PER_AGENT = 100;

class MessageAttachmentStore {
  private ledger = new Map<string, LedgerEntry[]>();

  record(
    agentId: string,
    entry: {
      clientMessageId: string;
      text: string;
      cards: AttachmentCard[];
    },
  ): void {
    if (entry.cards.length === 0) return;
    const list = this.ledger.get(agentId) ?? [];
    list.push({ ...entry, sentAt: Date.now(), consumed: false });
    while (list.length > MAX_ENTRIES_PER_AGENT) list.shift();
    this.ledger.set(agentId, list);
  }

  /** 为时间线 user_message 条目回配附件（无匹配返回空数组）。 */
  match(
    agentId: string,
    item: { text: string; clientMessageId?: string; messageId?: string },
  ): AttachmentCard[] {
    const list = this.ledger.get(agentId);
    if (!list || list.length === 0) return [];
    if (item.clientMessageId) {
      const hit = list.find((e) => !e.consumed && e.clientMessageId === item.clientMessageId);
      if (hit) {
        hit.consumed = true;
        return hit.cards;
      }
    }
    if (item.messageId) {
      const hit = list.find((e) => !e.consumed && e.clientMessageId === item.messageId);
      if (hit) {
        hit.consumed = true;
        return hit.cards;
      }
    }
    // 兜底：最近的同文本未配对条目
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (entry.consumed) continue;
      if (entry.text !== item.text) continue;
      if (Date.now() - entry.sentAt > TEXT_FALLBACK_WINDOW_MS) break;
      entry.consumed = true;
      return entry.cards;
    }
    return [];
  }

  clear(agentId?: string): void {
    if (agentId) this.ledger.delete(agentId);
    else this.ledger.clear();
  }
}

const GLOBAL_KEY = "__aaswitch_message_attachments";
const globalScope = globalThis as { [GLOBAL_KEY]?: MessageAttachmentStore };
export const messageAttachmentStore: MessageAttachmentStore = (globalScope[GLOBAL_KEY] ??=
  new MessageAttachmentStore());
