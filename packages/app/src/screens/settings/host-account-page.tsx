import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

import type { HubAccountStatus } from "@getpaseo/protocol/messages";

const hubAccountQueryKey = (serverId: string) => ["hub-account-status", serverId] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

interface AccountFormState {
  username: string;
  password: string;
  deviceName: string;
}

const EMPTY_FORM: AccountFormState = { username: "", password: "", deviceName: "" };

function AccountIdentityRows({ status }: { status: HubAccountStatus }) {
  const { t } = useTranslation();
  return (
    <>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{status.username ?? ""}</Text>
          <Text style={settingsStyles.rowHint}>{status.baseUrl ?? ""}</Text>
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.account.deviceName")}</Text>
          <Text style={settingsStyles.rowHint}>{status.deviceName ?? ""}</Text>
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.account.registration")}</Text>
          <Text style={settingsStyles.rowHint}>
            {status.registered
              ? t("settings.host.account.registrationActive")
              : t("settings.host.account.registrationIdle")}
          </Text>
        </View>
      </View>
    </>
  );
}

function AccountSignedInCard({
  status,
  onLogout,
  logoutPending,
}: {
  status: HubAccountStatus;
  onLogout: () => void;
  logoutPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card}>
      <AccountIdentityRows status={status} />
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

function AccountLoginForm({
  status,
  serverId,
  form,
  onFormChange,
  onSubmitted,
}: {
  status: HubAccountStatus | null;
  serverId: string;
  form: AccountFormState;
  onFormChange: (patch: Partial<AccountFormState>) => void;
  onSubmitted: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);

  const loginMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      // The daemon knows its hub address (env override, persisted config, or
      // the built-in default), so the form only collects credentials.
      await client.loginHubAccount({
        username: form.username.trim(),
        password: form.password,
      });
    },
    onSuccess: onSubmitted,
  });
  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.registerHubAccount({
        username: form.username.trim(),
        password: form.password,
        ...(form.deviceName.trim() ? { deviceName: form.deviceName.trim() } : {}),
      });
    },
    onSuccess: onSubmitted,
  });

  const pending = loginMutation.isPending || registerMutation.isPending;
  const canSubmit = !isBlank(form.username) && !isBlank(form.password);
  const mutationError = loginMutation.error ?? registerMutation.error;

  const changeUsername = useCallback(
    (value: string) => onFormChange({ username: value }),
    [onFormChange],
  );
  const changePassword = useCallback(
    (value: string) => onFormChange({ password: value }),
    [onFormChange],
  );
  const changeDeviceName = useCallback(
    (value: string) => onFormChange({ deviceName: value }),
    [onFormChange],
  );
  const submitLogin = useCallback(() => {
    loginMutation.mutate();
  }, [loginMutation]);
  const submitRegister = useCallback(() => {
    registerMutation.mutate();
  }, [registerMutation]);

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.account.signInTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.account.signInHint")}</Text>
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <Field label={t("settings.host.account.fields.username")}>
          <FormTextInput
            initialValue=""
            onChangeText={changeUsername}
            placeholder={t("settings.host.account.fields.usernamePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={t("settings.host.account.fields.username")}
          />
        </Field>
        <Field label={t("settings.host.account.fields.password")}>
          <FormTextInput
            initialValue=""
            onChangeText={changePassword}
            placeholder={t("settings.host.account.fields.passwordPlaceholder")}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={t("settings.host.account.fields.password")}
          />
        </Field>
        {status?.baseUrl ? (
          <Field label={t("settings.host.account.fields.baseUrl")}>
            <Text style={settingsStyles.rowHint}>{status.baseUrl}</Text>
          </Field>
        ) : null}
        <Field
          label={t("settings.host.account.fields.deviceName")}
          hint={t("settings.host.account.fields.deviceNameHint")}
        >
          <FormTextInput
            initialValue=""
            onChangeText={changeDeviceName}
            placeholder={status?.deviceName ?? ""}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={t("settings.host.account.fields.deviceName")}
          />
        </Field>
        {mutationError ? (
          <View style={styles.feedback}>
            <Alert size="sm" variant="error" title={errorMessage(mutationError)} />
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="default"
            onPress={submitLogin}
            loading={loginMutation.isPending}
            disabled={!canSubmit || pending}
          >
            {t("settings.host.account.actions.login")}
          </Button>
          <Button
            variant="outline"
            onPress={submitRegister}
            loading={registerMutation.isPending}
            disabled={!canSubmit || pending}
          >
            {t("settings.host.account.actions.register")}
          </Button>
        </View>
      </View>
    </View>
  );
}

export function HostAccountPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "hubAccountRpc");
  const hosts = useHosts();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => hubAccountQueryKey(serverId), [serverId]);
  const [form, setForm] = useState<AccountFormState>(EMPTY_FORM);

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
      setForm(EMPTY_FORM);
      refreshStatus();
    },
  });
  const submitLogout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const handleFormChange = useCallback((patch: Partial<AccountFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);
  const handleLoginSubmitted = useCallback(() => {
    setForm(EMPTY_FORM);
    refreshStatus();
  }, [refreshStatus]);

  if (!hosts.some((host) => host.serverId === serverId)) {
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
      {!supported ? (
        <Alert
          size="sm"
          variant="warning"
          title={t("settings.host.account.updateHost")}
          testID="hub-account-unsupported"
        />
      ) : null}
      {supported && !isConnected ? (
        <Alert size="sm" variant="warning" title={t("settings.host.account.disconnected")} />
      ) : null}
      {status?.loggedIn ? (
        <AccountSignedInCard
          status={status}
          onLogout={submitLogout}
          logoutPending={logoutMutation.isPending}
        />
      ) : null}
      {status && !status.loggedIn ? (
        <AccountLoginForm
          status={status}
          serverId={serverId}
          form={form}
          onFormChange={handleFormChange}
          onSubmitted={handleLoginSubmitted}
        />
      ) : null}
      {supported && isConnected && !status ? (
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={settingsStyles.rowHint}>{t("settings.host.account.loading")}</Text>
        </View>
      ) : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
  },
  feedback: {
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
