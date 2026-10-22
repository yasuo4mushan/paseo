/**
 * 附件本地台账（t17）：clientMessageId / messageId / 同文本兜底匹配。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  messageAttachmentStore,
  type AttachmentCard,
} from "../src/stores/message-attachment-store";

const CARDS: AttachmentCard[] = [
  { kind: "image", fileName: "pic.png", size: 100, localPath: "tmp://pic.png" },
  { kind: "file", fileName: "note.md", size: 20 },
];

describe("message-attachment-store", () => {
  beforeEach(() => {
    messageAttachmentStore.clear();
  });

  it("clientMessageId 精确匹配并只消费一次", () => {
    messageAttachmentStore.record("a1", { clientMessageId: "cm-1", text: "看图", cards: CARDS });
    expect(messageAttachmentStore.match("a1", { text: "看图", clientMessageId: "cm-1" })).toEqual(
      CARDS,
    );
    // 第二次同 id 匹配不再返回（已消费）
    expect(messageAttachmentStore.match("a1", { text: "看图", clientMessageId: "cm-1" })).toEqual(
      [],
    );
  });

  it("messageId 命中同 clientMessageId 的台账", () => {
    messageAttachmentStore.record("a1", { clientMessageId: "cm-2", text: "文件", cards: CARDS });
    expect(messageAttachmentStore.match("a1", { text: "文件", messageId: "cm-2" })).toEqual(CARDS);
  });

  it("无 id 时按同文本兜底匹配最近的未消费条目", () => {
    messageAttachmentStore.record("a1", {
      clientMessageId: "cm-3",
      text: "补充材料",
      cards: CARDS,
    });
    expect(messageAttachmentStore.match("a1", { text: "补充材料" })).toEqual(CARDS);
  });

  it("agent 之间隔离；文本不同不匹配", () => {
    messageAttachmentStore.record("a1", { clientMessageId: "cm-4", text: "x", cards: CARDS });
    expect(messageAttachmentStore.match("a2", { text: "x" })).toEqual([]);
    expect(messageAttachmentStore.match("a1", { text: "y" })).toEqual([]);
  });

  it("空卡片不记账", () => {
    messageAttachmentStore.record("a1", { clientMessageId: "cm-5", text: "z", cards: [] });
    expect(messageAttachmentStore.match("a1", { text: "z", clientMessageId: "cm-5" })).toEqual([]);
  });
});
