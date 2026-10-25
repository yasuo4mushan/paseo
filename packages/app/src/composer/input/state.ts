import type { DaemonClient } from "@aaswitch/client/internal/daemon-client";
import type { ActiveTurnBehavior } from "@aaswitch/protocol/messages";
import type { MessagePayload, TextReplacement } from "@/composer/types";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";

export type SendBehavior = ActiveTurnBehavior | "queue";

export function resolveActiveSendBehavior(
  sendBehavior: SendBehavior,
  hasPendingPermission: boolean,
): SendBehavior {
  return sendBehavior === "queue" && hasPendingPermission ? "interrupt" : sendBehavior;
}

interface ComposerSurfaceState {
  opacity: 0 | 1;
  pointerEvents: "auto" | "none";
}

export interface ComposerSurfacePresentation {
  input: ComposerSurfaceState;
  overlay: ComposerSurfaceState;
}

const INPUT_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 1, pointerEvents: "auto" },
  overlay: { opacity: 0, pointerEvents: "none" },
};

const OVERLAY_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 0, pointerEvents: "none" },
  overlay: { opacity: 1, pointerEvents: "auto" },
};

export function resolveComposerSurfacePresentation(
  showOverlay: boolean,
): ComposerSurfacePresentation {
  return showOverlay ? OVERLAY_PRESENTATION : INPUT_PRESENTATION;
}

interface StopRealtimeVoiceContext {
  voice: { stopVoice: () => Promise<unknown> } | null | undefined;
  isRealtimeVoiceForCurrentAgent: boolean;
  isAgentRunning: boolean;
  client: { cancelAgent: (agentId: string) => Promise<unknown> } | null;
  voiceAgentId: string | undefined;
}

interface SendActionContext {
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  handleSendMessage: () => void;
  handleQueueMessage: () => void;
}

interface DictationTranscriptContext {
  value: string;
  /** Caret/selection at dictation time; the transcript inserts here when provided. */
  selection?: { start: number; end: number };
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmit: (payload: MessagePayload) => void;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  attachments: MessagePayload["attachments"];
  cwd: string;
  autoSend: boolean;
}

// CJK text joins without spaces; only pad when at least one side is non-CJK.
const CJK_CHARACTER = /[\u3000-\u9fff\uff00-\uffef]/;

function needsJoinSpace(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (/\s/.test(a) || /\s/.test(b)) return false;
  return !(CJK_CHARACTER.test(a) || CJK_CHARACTER.test(b));
}

export function insertDictationTranscript(
  value: string,
  text: string,
  selection: { start: number; end: number } | undefined,
): { nextValue: string; nextSelection: { start: number; end: number } } {
  const caret =
    selection && selection.start >= 0 && selection.end >= selection.start
      ? selection
      : { start: value.length, end: value.length };
  if (caret.start >= value.length) {
    const pad = value.length > 0 && needsJoinSpace(value[value.length - 1], text[0]) ? " " : "";
    const nextValue = `${value}${pad}${text}`;
    return { nextValue, nextSelection: { start: nextValue.length, end: nextValue.length } };
  }
  const start = Math.min(caret.start, value.length);
  const end = Math.min(caret.end, value.length);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before.length > 0 && needsJoinSpace(before[before.length - 1], text[0]) ? " " : "";
  const tail = after.length > 0 && needsJoinSpace(text[text.length - 1], after[0]) ? " " : "";
  const nextValue = `${before}${lead}${text}${tail}${after}`;
  const insertEnd = start + lead.length + text.length;
  return { nextValue, nextSelection: { start: insertEnd, end: insertEnd } };
}

export function applyDictationTranscript(text: string, ctx: DictationTranscriptContext): void {
  if (!text) return;
  const { nextValue, nextSelection } = insertDictationTranscript(ctx.value, text, ctx.selection);

  if (!ctx.autoSend) {
    ctx.replaceText(nextValue, nextSelection);
    return;
  }

  ctx.replaceText(nextValue, nextSelection);

  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.onQueue({ text: nextValue, attachments: ctx.attachments, cwd: ctx.cwd });
    ctx.replaceText("");
    return;
  }

  ctx.onSubmit({
    text: nextValue,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
}

interface MessageInputKeyboardActions {
  focusInput: () => void;
  isDictationRecording: () => boolean;
  markTranscriptForSend: () => void;
  confirmDictation: () => void | Promise<void>;
  cancelDictation: () => void | Promise<void>;
  startDictation: () => void | Promise<void>;
  toggleRealtimeVoice: () => void;
  isRealtimeVoiceActive: boolean;
  toggleRealtimeVoiceMute: () => void;
}

export function computeCanStartDictation(input: {
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  disabled: boolean;
  dictationUnavailableMessage: string | null | undefined;
}): boolean {
  const socketConnected = input.client?.isConnected ?? false;
  const readyForDictation = input.isReadyForDictation ?? socketConnected;
  return (
    socketConnected && readyForDictation && !input.disabled && !input.dictationUnavailableMessage
  );
}

export function runDefaultSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
    return;
  }
  ctx.handleSendMessage();
}

export function runAlternateSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue") {
    ctx.handleSendMessage();
    return;
  }
  if (ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
  }
}

export function runMessageInputKeyboardAction(
  action: MessageInputKeyboardActionKind,
  actions: MessageInputKeyboardActions,
): boolean {
  if (action === "focus") {
    actions.focusInput();
    return true;
  }
  if (action === "send" || action === "dictation-confirm") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
      return true;
    }
    return false;
  }
  if (action === "voice-toggle") {
    actions.toggleRealtimeVoice();
    return true;
  }
  if (action === "voice-mute-toggle") {
    if (actions.isRealtimeVoiceActive) {
      actions.toggleRealtimeVoiceMute();
    }
    return true;
  }
  if (action === "dictation-cancel") {
    if (actions.isDictationRecording()) {
      void actions.cancelDictation();
      return true;
    }
    return false;
  }
  if (action === "dictation-toggle") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
    } else {
      void actions.startDictation();
    }
    return true;
  }
  return false;
}

export async function stopRealtimeVoice(ctx: StopRealtimeVoiceContext): Promise<void> {
  if (!ctx.voice || !ctx.isRealtimeVoiceForCurrentAgent) return;

  if (ctx.isAgentRunning) {
    if (!ctx.client || !ctx.voiceAgentId) {
      throw new Error("Cannot stop the running voice agent while the host is unavailable");
    }
    await ctx.client.cancelAgent(ctx.voiceAgentId);
  }

  await ctx.voice.stopVoice();
}

/**
 * Offset that aligns a glyph's visible ink with the Send arrow's ink when both sit in
 * equal controls on the same right rail. In Lucide's 24px viewBox ArrowUp ends at
 * x19 while Maximize2/Minimize2 end at x21, so equal boxes leave the fullscreen
 * glyphs visibly past the arrow.
 */
export function resolveGlyphRailOffset(input: {
  controlSize: number;
  sendIconSize: number;
  glyphIconSize: number;
}): number {
  const arrowInkInset =
    (input.controlSize - input.sendIconSize) / 2 + (5 * input.sendIconSize) / 24;
  const glyphInkInset =
    (input.controlSize - input.glyphIconSize) / 2 + (3 * input.glyphIconSize) / 24;
  return arrowInkInset - glyphInkInset;
}

export function resolveComposerSurfaceText(
  liveText: string,
  replacement: TextReplacement,
  appliedReplacementKey: string,
): string {
  return replacement.key === appliedReplacementKey ? liveText : replacement.text;
}

/** A retained caret must fit the text the remounted editor shows. */
export function resolveRetainedSelection(
  retained: { start: number; end: number },
  textLength: number,
): { start: number; end: number } {
  const end = Math.min(Math.max(retained.end, 0), textLength);
  const start = Math.min(Math.max(retained.start, 0), end);
  return { start, end };
}
