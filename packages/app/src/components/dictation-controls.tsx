import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { VolumeMeter } from "./volume-meter";
import { DictationWaveform } from "./dictation-waveform";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function resolveOverlayHintText(input: {
  t: (key: string, options?: Record<string, unknown>) => string;
  status: DictationStatus;
  isFailed: boolean;
  isProcessing: boolean;
  cancelArmed: boolean;
  holdMode: boolean;
  errorText?: string;
}): string | null {
  const { t } = input;
  if (input.isFailed) {
    return input.errorText
      ? t("message.dictation.failed", { error: input.errorText })
      : t("message.dictation.failedRetry");
  }
  if (input.status === "paused") {
    return t("message.dictation.paused");
  }
  if (input.isProcessing) {
    return t("message.dictation.processing");
  }
  if (input.cancelArmed) {
    return t("message.dictation.cancelArmedHint");
  }
  if (input.holdMode) {
    return t("message.dictation.holdHint");
  }
  return null;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const micButtonStyle = useMemo(
    () => [styles.micButton, disabled && styles.buttonDisabled],
    [disabled],
  );
  const timerTextStyle = useMemo(
    () => [styles.timerText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const cancelButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.actionButtonCancel,
      actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
    ],
    [actionsDisabled, isFailed],
  );

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.start")}
        style={micButtonStyle}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter volume={volume} isMuted={false} isSpeaking={false} orientation="horizontal" />
      </View>
      <Text style={timerTextStyle}>
        {status === "paused" ? t("message.dictation.paused") : formatDuration(duration)}
      </Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel={t("message.dictation.cancel")}
          style={cancelButtonStyle}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.foreground} />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel={t("message.dictation.retry")}
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel={t("message.dictation.insert")}
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function DictationOverlayActions(input: {
  isFailed: boolean;
  isProcessing: boolean;
  holdMode: boolean;
  onAccept: () => void | Promise<void>;
  onAcceptAndSend: () => void | Promise<void>;
  onRetry?: () => void;
}): React.ReactElement | null {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  if (input.isProcessing) {
    return (
      <View style={overlayStyles.loadingContainer}>
        <LoadingSpinner size="small" color={theme.colors.accentForeground} />
      </View>
    );
  }
  if (input.isFailed) {
    return (
      <Pressable
        onPress={input.onRetry}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.retry")}
        testID="dictation-overlay-retry"
        style={[overlayStyles.actionButton, { backgroundColor: theme.colors.accentForeground }]}
      >
        <RefreshCcw size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
      </Pressable>
    );
  }
  if (input.holdMode) {
    return <View style={overlayStyles.holdModeSpacer} />;
  }
  return (
    <>
      <Pressable
        onPress={input.onAccept}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.insert")}
        testID="dictation-overlay-accept"
        style={[overlayStyles.actionButton, OVERLAY_ACCEPT_BUTTON_BG]}
      >
        <Pencil size={theme.iconSize.lg} color={theme.colors.accentForeground} strokeWidth={2.5} />
      </Pressable>
      <Pressable
        onPress={input.onAcceptAndSend}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.insertAndSend")}
        testID="dictation-overlay-accept-send"
        style={[overlayStyles.actionButton, { backgroundColor: theme.colors.accentForeground }]}
      >
        <ArrowUp size={theme.iconSize.lg} color={theme.colors.accent} strokeWidth={2.5} />
      </Pressable>
    </>
  );
}

/**
 * Full-width overlay variant for the agent input footer.
 * Uses blue background with white icons.
 *
 * Doubao-style layout: a big mic orb and loudness waveform sit in the middle,
 * the live partial transcript renders above them, and the left button cancels.
 * In hold mode (press-and-hold input) releasing the button confirms, so the
 * accept buttons only render in toggle mode.
 */
export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  partialTranscript,
  holdMode = false,
  cancelArmed = false,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "transcript"> & {
  errorText?: string;
  partialTranscript?: string;
  holdMode?: boolean;
  cancelArmed?: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const containerStyle = useMemo(
    () => [
      overlayStyles.container,
      { backgroundColor: cancelArmed ? theme.colors.destructive : theme.colors.accent },
    ],
    [cancelArmed, theme.colors.accent, theme.colors.destructive],
  );
  const overlayCancelButtonStyle = useMemo(
    () => [
      overlayStyles.cancelButton,
      actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
    ],
    [actionsDisabled, isFailed],
  );
  const overlayTimerTextStyle = useMemo(
    () => [overlayStyles.timerText, { color: theme.colors.accentForeground }],
    [theme.colors.accentForeground],
  );
  const overlayTranscriptTextStyle = useMemo(
    () => [overlayStyles.transcriptText, { color: theme.colors.accentForeground }],
    [theme.colors.accentForeground],
  );
  const overlayHintTextStyle = useMemo(
    () => [
      overlayStyles.hintText,
      { color: cancelArmed ? theme.colors.accentForeground : theme.colors.accentForeground },
    ],
    [cancelArmed, theme.colors.accentForeground],
  );
  const orbStyle = useMemo(
    () => [overlayStyles.micOrb, cancelArmed && overlayStyles.micOrbArmed],
    [cancelArmed],
  );

  if (!showActiveState) {
    return null;
  }

  const hintText = resolveOverlayHintText({
    t,
    status,
    isFailed,
    isProcessing,
    cancelArmed,
    holdMode,
    errorText,
  });

  return (
    <View style={containerStyle}>
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.cancel")}
        testID="dictation-overlay-cancel"
        style={overlayCancelButtonStyle}
      >
        <X size={theme.iconSize.lg} color={theme.colors.accentForeground} strokeWidth={2.5} />
      </Pressable>

      <View style={overlayStyles.centerContainer}>
        {!isFailed && partialTranscript && partialTranscript.length > 0 ? (
          <Text
            numberOfLines={2}
            style={overlayTranscriptTextStyle}
            testID="dictation-overlay-partial"
          >
            {partialTranscript}
          </Text>
        ) : null}
        <View style={overlayStyles.meterRow}>
          <View style={orbStyle} pointerEvents="none">
            <Mic size={theme.iconSize.lg + 4} color={theme.colors.accentForeground} />
          </View>
          <View style={overlayStyles.waveformColumn}>
            <DictationWaveform volume={volume} color={theme.colors.accentForeground} />
            <View style={overlayStyles.statusRow}>
              <Text style={overlayTimerTextStyle}>{formatDuration(duration)}</Text>
              {hintText ? (
                <Text numberOfLines={1} style={overlayHintTextStyle}>
                  {hintText}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      </View>

      <View style={overlayStyles.actionButtonsContainer}>
        <DictationOverlayActions
          isFailed={isFailed}
          isProcessing={actionsDisabled}
          holdMode={holdMode}
          onAccept={onAccept}
          onAcceptAndSend={onAcceptAndSend}
          onRetry={onRetry}
        />
      </View>
    </View>
  );
}

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_MIC_ORB_SIZE = 46;
const OVERLAY_VERTICAL_PADDING = Math.max(
  4,
  (FOOTER_HEIGHT - Math.max(OVERLAY_BUTTON_SIZE, OVERLAY_MIC_ORB_SIZE)) / 2,
);

const overlayStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    minHeight: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  micOrb: {
    width: OVERLAY_MIC_ORB_SIZE,
    height: OVERLAY_MIC_ORB_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  micOrbArmed: {
    backgroundColor: "rgba(0, 0, 0, 0.28)",
  },
  waveformColumn: {
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: theme.spacing[1],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  hintText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    opacity: 0.85,
  },
  transcriptText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.95,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  holdModeSpacer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
  },
}));

const OVERLAY_ACCEPT_BUTTON_BG = { backgroundColor: "rgba(255, 255, 255, 0.25)" };
