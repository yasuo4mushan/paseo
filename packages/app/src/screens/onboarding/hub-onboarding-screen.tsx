import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, RotateCw } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { DensityIcon } from "@/components/ui/density-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { useProviderIcons } from "@/components/provider-icons";
import { useToast } from "@/contexts/toast-api-context";
import { useHubAccountStatus } from "@/data/hub-account-status";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useEarliestOnlineHostServerId } from "@/app/_layout";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { useHubOnboardingGateStore } from "@/screens/onboarding/hub-onboarding-gate-store";
import {
  hubAccountErrorKey,
  isHubAccountFormSubmittable,
  normalizePhoneInput,
  validateHubAccountForm,
  type HubAccountFormValidation,
} from "@/screens/onboarding/hub-account-form";
import {
  buildProviderChecklistRows,
  checklistStateLabelKey,
  type ProviderChecklistRow,
  type ProviderChecklistState,
} from "@/screens/onboarding/provider-checklist";

/**
 * t29 first-run onboarding (Web/desktop): hub login/register → device-name
 * confirm → agent checklist → done. Reached from the startup gate while the
 * daemon holds no hub login, from the sidebar account entry, and again after
 * a Settings logout.
 */
export type OnboardingPhase = "credentials" | "device" | "agents" | "done";

type OnboardingMode = "login" | "register";

interface CredentialsFormState {
  phone: string;
  password: string;
}

const EMPTY_CREDENTIALS: CredentialsFormState = { phone: "", password: "" };

/** spacing[6] as a literal: static padding added to the safe-area inset. */
const SCROLL_BOTTOM_PADDING = 24;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorTextForKey(key: string | null, error: unknown, t: (key: string) => string): string {
  return key ? t(`hubOnboarding.errors.${key}`) : toErrorMessage(error);
}

const ThemedCheck = withUnistyles(Check);
const ThemedCopy = withUnistyles(Copy);
const successIconColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function SpinnerGlyph({ size, color }: { size?: number; color: string }) {
  return <LoadingSpinner size={size} color={color} />;
}
const ThemedSpinner = withUnistyles(SpinnerGlyph);

function CommandChip({ command, testID }: { command: string; testID: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(command);
      setCopied(true);
      toast.copied(command);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("hubOnboarding.commandCopyFailed"));
    }
  }, [command, t, toast]);

  const handlePress = useCallback(() => {
    void handleCopy();
  }, [handleCopy]);

  return (
    <View style={styles.commandRow} testID={testID}>
      <Text style={styles.commandText} numberOfLines={1} selectable>
        {command}
      </Text>
      <Pressable
        style={styles.commandCopyButton}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t("hubOnboarding.copyCommand", { command })}
        testID={`${testID}-copy`}
      >
        {copied ? (
          <ThemedCheck size={14} uniProps={successIconColor} />
        ) : (
          <ThemedCopy size={14} uniProps={mutedIconColor} />
        )}
      </Pressable>
    </View>
  );
}

function checklistDotStyle(state: ProviderChecklistState) {
  if (state === "ready") return styles.statusDotSuccess;
  if (state === "needs-login") return styles.statusDotWarning;
  return styles.statusDotMuted;
}

function checklistCommand(row: ProviderChecklistRow): string | null {
  if (row.state === "needs-login") return row.loginCommand;
  if (row.state === "not-installed") return row.installCommand;
  return null;
}

function ChecklistStatusDot({ state }: { state: ProviderChecklistState }) {
  if (state === "checking") {
    return <ThemedSpinner size={12} uniProps={mutedIconColor} />;
  }
  return <View style={[styles.statusDot, checklistDotStyle(state)]} />;
}

export function ChecklistRow({
  row,
  serverId,
  testID,
}: {
  row: ProviderChecklistRow;
  serverId: string | null;
  testID: string;
}) {
  const { t } = useTranslation();
  const resolveIcon = useProviderIcons(serverId);
  const Icon = resolveIcon(row.provider);

  const command = checklistCommand(row);

  return (
    <View
      style={[styles.checklistRow, row.domestic ? null : styles.checklistRowTrailing]}
      testID={testID}
    >
      <View style={styles.checklistRowHead}>
        <DensityIcon icon={Icon} size="md" color="foreground" />
        <Text style={styles.checklistRowTitle}>{row.label}</Text>
        <View style={styles.statusRow}>
          <ChecklistStatusDot state={row.state} />
          <Text style={styles.statusLabel}>
            {t(`hubOnboarding.providers.states.${checklistStateLabelKey(row.state)}`)}
          </Text>
        </View>
      </View>
      {row.state === "ready" && row.provider === "zcode" ? (
        <Text style={styles.checklistHint}>{t("hubOnboarding.providers.zcodeReady")}</Text>
      ) : null}
      {command ? (
        <View style={styles.checklistCommandBlock}>
          <Text style={styles.checklistHint}>
            {row.state === "needs-login"
              ? t("hubOnboarding.providers.loginHint")
              : t("hubOnboarding.providers.installHint")}
          </Text>
          <CommandChip command={command} testID={`${testID}-command`} />
        </View>
      ) : null}
    </View>
  );
}

function fieldError(
  value: string,
  error: string | null,
  t: (key: string) => string,
): string | null {
  if (value.length === 0 || error === null) return null;
  return t(`hubOnboarding.errors.${error}`);
}

interface CredentialsStepProps {
  mode: OnboardingMode;
  form: CredentialsFormState;
  validation: HubAccountFormValidation;
  pending: boolean;
  errorText: string | null;
  onModeChange: (mode: OnboardingMode) => void;
  onPhoneChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
}

function CredentialsStep({
  mode,
  form,
  validation,
  pending,
  errorText,
  onModeChange,
  onPhoneChange,
  onPasswordChange,
  onSubmit,
  onSkip,
}: CredentialsStepProps) {
  const { t } = useTranslation();
  const canSubmit = isHubAccountFormSubmittable(form) && !pending;
  const selectLogin = useCallback(() => onModeChange("login"), [onModeChange]);
  const selectRegister = useCallback(() => onModeChange("register"), [onModeChange]);

  return (
    <View style={styles.card} testID="hub-onboarding-step-credentials">
      <View style={styles.modeRow}>
        <Button
          variant={mode === "login" ? "default" : "outline"}
          size="sm"
          onPress={selectLogin}
          testID="hub-onboarding-mode-login"
        >
          {t("hubOnboarding.mode.login")}
        </Button>
        <Button
          variant={mode === "register" ? "default" : "outline"}
          size="sm"
          onPress={selectRegister}
          testID="hub-onboarding-mode-register"
        >
          {t("hubOnboarding.mode.register")}
        </Button>
      </View>
      <Field
        label={t("hubOnboarding.fields.phone")}
        error={fieldError(form.phone, validation.phoneError, t)}
        testID="hub-onboarding-phone-field"
      >
        <FormTextInput
          initialValue=""
          onChangeText={onPhoneChange}
          placeholder={t("hubOnboarding.fields.phonePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="phone-pad"
          editable={!pending}
          accessibilityLabel={t("hubOnboarding.fields.phone")}
        />
      </Field>
      <Field
        label={t("hubOnboarding.fields.password")}
        error={fieldError(form.password, validation.passwordError, t)}
        testID="hub-onboarding-password-field"
      >
        <FormTextInput
          initialValue=""
          onChangeText={onPasswordChange}
          placeholder={t("hubOnboarding.fields.passwordPlaceholder")}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          accessibilityLabel={t("hubOnboarding.fields.password")}
        />
      </Field>
      {errorText ? (
        <View style={styles.feedback}>
          <Alert size="sm" variant="error" title={errorText} testID="hub-onboarding-submit-error" />
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="default"
          onPress={onSubmit}
          loading={pending}
          disabled={!canSubmit}
          testID="hub-onboarding-submit"
        >
          {mode === "login"
            ? t("hubOnboarding.actions.login")
            : t("hubOnboarding.actions.register")}
        </Button>
      </View>
      <Pressable onPress={onSkip} style={styles.skipLink} testID="hub-onboarding-skip">
        <Text style={styles.skipLinkText}>{t("hubOnboarding.actions.skip")}</Text>
      </Pressable>
    </View>
  );
}

interface DeviceStepProps {
  defaultName: string | null;
  value: string;
  pending: boolean;
  errorText: string | null;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
}

function DeviceStep({
  defaultName,
  value,
  pending,
  errorText,
  onValueChange,
  onConfirm,
}: DeviceStepProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.card} testID="hub-onboarding-step-device">
      <Text style={styles.stepTitle}>{t("hubOnboarding.device.title")}</Text>
      <Text style={styles.stepSubtitle}>{t("hubOnboarding.device.subtitle")}</Text>
      <Field
        label={t("hubOnboarding.device.nameLabel")}
        hint={t("hubOnboarding.device.nameHint")}
        testID="hub-onboarding-device-field"
      >
        <FormTextInput
          initialValue={defaultName ?? ""}
          onChangeText={onValueChange}
          placeholder={defaultName ?? ""}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          accessibilityLabel={t("hubOnboarding.device.nameLabel")}
        />
      </Field>
      {errorText ? (
        <View style={styles.feedback}>
          <Alert size="sm" variant="error" title={errorText} />
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="default"
          onPress={onConfirm}
          loading={pending}
          disabled={value.trim().length === 0}
          testID="hub-onboarding-device-confirm"
        >
          {t("hubOnboarding.device.confirm")}
        </Button>
      </View>
    </View>
  );
}

interface AgentsStepProps {
  rows: ProviderChecklistRow[];
  serverId: string | null;
  loading: boolean;
  onRefresh: () => void;
  onNext: () => void;
}

function AgentsStep({ rows, serverId, loading, onRefresh, onNext }: AgentsStepProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.card} testID="hub-onboarding-step-agents">
      <Text style={styles.stepTitle}>{t("hubOnboarding.providers.title")}</Text>
      <Text style={styles.stepSubtitle}>{t("hubOnboarding.providers.subtitle")}</Text>
      <View style={styles.refreshRow}>
        <Text style={styles.statusLabel}>{t("hubOnboarding.providers.refreshHint")}</Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={RotateCw}
          onPress={onRefresh}
          testID="hub-onboarding-providers-refresh"
        >
          {t("hubOnboarding.providers.refresh")}
        </Button>
      </View>
      {loading && rows.length === 0 ? (
        <View style={styles.checklistLoading}>
          <ThemedSpinner size={16} uniProps={mutedIconColor} />
        </View>
      ) : null}
      <View style={styles.checklistCard}>
        {rows.map((row) => (
          <ChecklistRow
            key={row.provider}
            row={row}
            serverId={serverId}
            testID={`hub-onboarding-provider-${row.provider}`}
          />
        ))}
      </View>
      <View style={styles.actions}>
        <Button variant="default" onPress={onNext} testID="hub-onboarding-agents-next">
          {t("hubOnboarding.providers.next")}
        </Button>
      </View>
    </View>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card} testID="hub-onboarding-step-done">
      <View style={styles.doneIconRow}>
        <View style={styles.doneIconBadge}>
          <ThemedCheck size={28} uniProps={successIconColor} />
        </View>
      </View>
      <Text style={styles.stepTitle}>{t("hubOnboarding.done.title")}</Text>
      <Text style={styles.stepSubtitle}>{t("hubOnboarding.done.subtitle")}</Text>
      <View style={styles.actions}>
        <Button variant="default" onPress={onFinish} testID="hub-onboarding-finish">
          {t("hubOnboarding.done.enter")}
        </Button>
      </View>
    </View>
  );
}

export function HubOnboardingScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const serverId = useEarliestOnlineHostServerId();
  const { status, supported, connected, client, invalidate } = useHubAccountStatus(serverId ?? "");
  const dismissGate = useHubOnboardingGateStore((state) => state.dismiss);
  const [phase, setPhase] = useState<OnboardingPhase>("credentials");
  const [mode, setMode] = useState<OnboardingMode>("login");
  const [form, setForm] = useState<CredentialsFormState>(EMPTY_CREDENTIALS);
  const [deviceName, setDeviceName] = useState("");

  const { entries, isLoading: snapshotLoading, refresh } = useProvidersSnapshot(serverId);
  const checklistRows = useMemo(() => buildProviderChecklistRows(entries), [entries]);

  // Someone who is already signed in (reopened from the sidebar entry, or a
  // login raced with the gate) starts at the agent checklist.
  useEffect(() => {
    if (phase === "credentials" && status?.loggedIn) {
      setPhase("agents");
    }
  }, [phase, status?.loggedIn]);

  // Prefill the device name once the status reports one (defaults to the
  // machine hostname on the daemon side).
  useEffect(() => {
    if (phase === "device" && deviceName.length === 0 && status?.deviceName) {
      setDeviceName(status.deviceName);
    }
  }, [phase, deviceName.length, status?.deviceName]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const input = {
        phone: normalizePhoneInput(form.phone),
        password: form.password,
      };
      if (mode === "register") {
        await client.registerHubAccount(input);
      } else {
        await client.loginHubAccount(input);
      }
    },
    onSuccess: () => {
      invalidate();
      setPhase("device");
    },
  });

  const renameMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const next = deviceName.trim();
      if (!next || next === status?.deviceName) return;
      await client.setHubDeviceName({ name: next });
    },
    onSuccess: () => {
      invalidate();
      setPhase("agents");
    },
  });

  const validation = useMemo(() => validateHubAccountForm(form), [form]);
  const submitErrorText =
    submitMutation.error === null
      ? null
      : errorTextForKey(hubAccountErrorKey(submitMutation.error), submitMutation.error, t);

  const handleFormChange = useCallback((patch: Partial<CredentialsFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);
  const changePhone = useCallback(
    (value: string) => handleFormChange({ phone: value }),
    [handleFormChange],
  );
  const changePassword = useCallback(
    (value: string) => handleFormChange({ password: value }),
    [handleFormChange],
  );
  const changeMode = useCallback((next: OnboardingMode) => setMode(next), []);
  const submit = useCallback(() => {
    submitMutation.mutate();
  }, [submitMutation]);

  const handleSkip = useCallback(() => {
    dismissGate();
    router.replace(buildOpenProjectRoute());
  }, [dismissGate, router]);

  const handleDeviceConfirm = useCallback(() => {
    renameMutation.mutate();
  }, [renameMutation]);

  const handleRefreshProviders = useCallback(() => {
    void refresh().catch(() => {
      toast.error(t("hubOnboarding.providers.refreshFailed"));
    });
  }, [refresh, t, toast]);

  const goDone = useCallback(() => setPhase("done"), []);
  const handleFinish = useCallback(() => {
    dismissGate();
    router.replace(buildOpenProjectRoute());
  }, [dismissGate, router]);

  const scrollContentContainerStyle = useMemo(
    () => [styles.container, { paddingBottom: SCROLL_BOTTOM_PADDING + insets.bottom }],
    [insets.bottom],
  );

  return (
    <View style={styles.root} testID="hub-onboarding-screen">
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <View style={styles.brandBlock}>
            <PaseoLogo size={64} />
            <Text style={styles.title}>{t("hubOnboarding.title")}</Text>
            <Text style={styles.subtitle}>{t("hubOnboarding.subtitle")}</Text>
          </View>

          {supported && !connected ? (
            <View style={styles.feedback}>
              <Alert size="sm" variant="warning" title={t("settings.host.account.disconnected")} />
            </View>
          ) : null}
          {!supported ? (
            <View style={styles.feedback}>
              <Alert size="sm" variant="warning" title={t("settings.host.account.updateHost")} />
            </View>
          ) : null}

          {phase === "credentials" ? (
            <CredentialsStep
              mode={mode}
              form={form}
              validation={validation}
              pending={submitMutation.isPending}
              errorText={submitErrorText}
              onModeChange={changeMode}
              onPhoneChange={changePhone}
              onPasswordChange={changePassword}
              onSubmit={submit}
              onSkip={handleSkip}
            />
          ) : null}
          {phase === "device" ? (
            <DeviceStep
              defaultName={status?.deviceName ?? null}
              value={deviceName}
              pending={renameMutation.isPending}
              errorText={
                renameMutation.error === null
                  ? null
                  : errorTextForKey(
                      hubAccountErrorKey(renameMutation.error),
                      renameMutation.error,
                      t,
                    )
              }
              onValueChange={setDeviceName}
              onConfirm={handleDeviceConfirm}
            />
          ) : null}
          {phase === "agents" ? (
            <AgentsStep
              rows={checklistRows}
              serverId={serverId}
              loading={snapshotLoading}
              onRefresh={handleRefreshProviders}
              onNext={goDone}
            />
          ) : null}
          {phase === "done" ? <DoneStep onFinish={handleFinish} /> : null}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    maxWidth: 520,
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "stretch",
  },
  brandBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[6],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modeRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  stepTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  stepSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  feedback: {
    marginTop: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  skipLink: {
    alignSelf: "center",
    marginTop: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  skipLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  refreshRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  checklistLoading: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  checklistCard: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  checklistRow: {
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  checklistRowTrailing: {
    backgroundColor: theme.colors.surface1,
  },
  checklistRowHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checklistRowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusDotSuccess: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusDotWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  statusDotMuted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  statusLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  checklistHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  checklistCommandBlock: {
    gap: theme.spacing[1.5],
  },
  commandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  commandText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  commandCopyButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  doneIconRow: {
    alignItems: "center",
  },
  doneIconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
