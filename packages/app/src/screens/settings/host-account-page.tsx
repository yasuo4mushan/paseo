import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { hubAccountStatusQueryKey } from "@/data/hub-account-status";
import { isWeb } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { useHubOnboardingGateStore } from "@/screens/onboarding/hub-onboarding-gate-store";
import { resolveHostAccountPageState } from "@/screens/settings/host-account-page-state";

import type { HubAccountStatus } from "@getpaseo/protocol/messages";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PasswordFormState {
  oldPassword: string;
  newPassword: string;
  newPasswordConfirm: string;
}

const EMPTY_PASSWORD_FORM: PasswordFormState = {
  oldPassword: "",
  newPassword: "",
  newPasswordConfirm: "",
};

function AccountIdentityRows({ status }: { status: HubAccountStatus }) {
  const { t } = useTranslation();
  // t30: every identity row uses the same 标题+hint two-line structure as the
  // rest of the page — the phone used to sit bare in the title slot.
  const rows: Array<{ label: string; value: string }> = [
    { label: t("settings.host.account.fields.phone"), value: status.phone ?? "" },
    ...(status.baseUrl
      ? [{ label: t("settings.host.account.fields.baseUrl"), value: status.baseUrl }]
      : []),
    { label: t("settings.host.account.deviceName"), value: status.deviceName ?? "" },
    {
      label: t("settings.host.account.registration"),
      value: status.registered
        ? t("settings.host.account.registrationActive")
        : t("settings.host.account.registrationIdle"),
    },
  ];
  return (
    <>
      {rows.map((row, index) => (
        <View
          key={row.label}
          style={index === 0 ? settingsStyles.row : [settingsStyles.row, settingsStyles.rowBorder]}
        >
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{row.label}</Text>
            <Text style={settingsStyles.rowHint}>{row.value}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

function AccountPasswordCard({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [form, setForm] = useState<PasswordFormState>(EMPTY_PASSWORD_FORM);
  const [expanded, setExpanded] = useState(false);

  const changeMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.changeHubAccountPassword({
        // WeChat one-click accounts that never set a password leave this blank.
        ...(form.oldPassword.trim() ? { oldPassword: form.oldPassword } : {}),
        newPassword: form.newPassword,
      });
    },
    onSuccess: () => {
      setForm(EMPTY_PASSWORD_FORM);
      setExpanded(false);
      onDone();
    },
  });

  const handleChange = useCallback((patch: Partial<PasswordFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);
  const changeOld = useCallback(
    (value: string) => handleChange({ oldPassword: value }),
    [handleChange],
  );
  const changeNew = useCallback(
    (value: string) => handleChange({ newPassword: value }),
    [handleChange],
  );
  const changeConfirm = useCallback(
    (value: string) => handleChange({ newPasswordConfirm: value }),
    [handleChange],
  );
  const expand = useCallback(() => setExpanded(true), []);
  const collapse = useCallback(() => {
    setExpanded(false);
    setForm(EMPTY_PASSWORD_FORM);
  }, []);
  const submitChange = useCallback(() => {
    changeMutation.mutate();
  }, [changeMutation]);

  if (!expanded) {
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Button variant="secondary" onPress={expand} testID="hub-account-change-password-expand">
            {t("settings.host.account.actions.changePassword")}
          </Button>
        </View>
      </View>
    );
  }

  const canSubmit =
    form.newPassword.length >= 8 &&
    form.newPassword === form.newPasswordConfirm &&
    !changeMutation.isPending;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        {/* t30: explicit column stack — the old login form relied on default
            flex direction and rendered its fields side-by-side, overflowing
            the viewport. Same shape as the onboarding card (t29). */}
        <View style={styles.stack}>
          <Field
            label={t("settings.host.account.fields.oldPassword")}
            hint={t("settings.host.account.fields.oldPasswordHint")}
          >
            <FormTextInput
              initialValue=""
              onChangeText={changeOld}
              placeholder={t("settings.host.account.fields.oldPassword")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!changeMutation.isPending}
              accessibilityLabel={t("settings.host.account.fields.oldPassword")}
            />
          </Field>
          <Field label={t("settings.host.account.fields.newPassword")}>
            <FormTextInput
              initialValue=""
              onChangeText={changeNew}
              placeholder={t("settings.host.account.fields.newPasswordPlaceholder")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!changeMutation.isPending}
              accessibilityLabel={t("settings.host.account.fields.newPassword")}
            />
          </Field>
          <Field
            label={t("settings.host.account.fields.newPasswordConfirm")}
            error={
              form.newPasswordConfirm && form.newPassword !== form.newPasswordConfirm
                ? t("settings.host.account.fields.passwordMismatch")
                : null
            }
          >
            <FormTextInput
              initialValue=""
              onChangeText={changeConfirm}
              placeholder={t("settings.host.account.fields.newPasswordConfirm")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!changeMutation.isPending}
              accessibilityLabel={t("settings.host.account.fields.newPasswordConfirm")}
            />
          </Field>
          {changeMutation.error ? (
            <Alert size="sm" variant="error" title={errorMessage(changeMutation.error)} />
          ) : null}
          <View style={styles.actions}>
            <Button variant="outline" onPress={collapse} disabled={changeMutation.isPending}>
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              onPress={submitChange}
              loading={changeMutation.isPending}
              disabled={!canSubmit}
              testID="hub-account-change-password-submit"
            >
              {t("settings.host.account.actions.changePassword")}
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

function AccountSignedInCard({
  status,
  serverId,
  onPasswordChanged,
  onLogout,
  logoutPending,
}: {
  status: HubAccountStatus;
  serverId: string;
  onPasswordChanged: () => void;
  onLogout: () => void;
  logoutPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card}>
      <AccountIdentityRows status={status} />
      <AccountPasswordCard serverId={serverId} onDone={onPasswordChanged} />
      {status.lastError ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Alert size="sm" variant="error" title={status.lastError} />
          </View>
        </View>
      ) : null}
      {status.relayEnabled ? null : (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Alert size="sm" variant="warning" title={t("settings.host.account.relayDisabled")} />
          </View>
        </View>
      )}
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Button
            variant="secondary"
            onPress={onLogout}
            loading={logoutPending}
            disabled={logoutPending}
          >
            {t("settings.host.account.actions.logout")}
          </Button>
        </View>
      </View>
    </View>
  );
}

/**
 * t30: the Settings account page no longer hosts a login/register form —
 * onboarding owns credentials (t29). Signed-out visitors get a pointer back
 * into the flow instead.
 */
function AccountSignedOutCard({
  baseUrl,
  onRunOnboarding,
}: {
  baseUrl: string | null;
  onRunOnboarding: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.account.signedOutTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.account.signedOutHint")}</Text>
        </View>
      </View>
      {baseUrl ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.host.account.fields.baseUrl")}</Text>
            <Text style={settingsStyles.rowHint}>{baseUrl}</Text>
          </View>
        </View>
      ) : null}
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Button variant="default" onPress={onRunOnboarding} testID="hub-account-rerun-onboarding">
            {t("settings.host.account.rerunOnboarding")}
          </Button>
        </View>
      </View>
    </View>
  );
}

export function HostAccountPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "hubAccountRpc");
  const hosts = useHosts();
  const queryClient = useQueryClient();
  const rearmOnboardingGate = useHubOnboardingGateStore((state) => state.rearm);
  const queryKey = useMemo(() => hubAccountStatusQueryKey(serverId), [serverId]);

  const statusQuery = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: Boolean(client && isConnected && supported),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getHubAccountStatus();
      return result.status;
    },
  });
  const status = statusQuery.data ?? null;

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const logoutMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.logoutHubAccount();
    },
    onSuccess: () => {
      refreshStatus();
      // t29: a logout re-arms the onboarding gate; on Web/desktop it also
      // reopens the flow so signing back in is one tap away.
      rearmOnboardingGate();
      if (isWeb) {
        router.replace("/onboarding");
      }
    },
  });
  const submitLogout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const handlePasswordChanged = useCallback(() => {
    refreshStatus();
  }, [refreshStatus]);

  // t30: rerunning onboarding from the signed-out card re-arms the gate so the
  // flow behaves exactly like a fresh session instead of a one-off detour.
  const runOnboarding = useCallback(() => {
    rearmOnboardingGate();
    router.push("/onboarding");
  }, [rearmOnboardingGate, router]);

  const pageState = resolveHostAccountPageState({
    hostExists: hosts.some((host) => host.serverId === serverId),
    supported,
    connected: isConnected,
    status,
  });

  if (pageState === "hostMissing") {
    return (
      <SettingsSection title={t("settings.hostSections.account")}>
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={settingsStyles.rowHint}>{t("settings.host.notFound")}</Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("settings.hostSections.account")}>
      {pageState === "unsupported" ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("settings.host.account.updateHost")}
          testID="hub-account-unsupported"
        />
      ) : null}
      {pageState === "disconnected" ? (
        <Alert size="sm" variant="warning" title={t("settings.host.account.disconnected")} />
      ) : null}
      {pageState === "loading" ? (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={settingsStyles.rowHint}>{t("settings.host.account.loading")}</Text>
        </View>
      ) : null}
      {pageState === "signedIn" && status ? (
        <AccountSignedInCard
          status={status}
          serverId={serverId}
          onPasswordChanged={handlePasswordChanged}
          onLogout={submitLogout}
          logoutPending={logoutMutation.isPending}
        />
      ) : null}
      {pageState === "signedOut" && status ? (
        <AccountSignedOutCard baseUrl={status.baseUrl} onRunOnboarding={runOnboarding} />
      ) : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
  },
  /** Vertical form stack for the change-password fields (t30 overflow fix). */
  stack: {
    flexDirection: "column",
    gap: theme.spacing[3],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
