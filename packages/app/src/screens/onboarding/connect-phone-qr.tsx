import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { useDaemonPairingOffer } from "@/hooks/use-daemon-pairing-offer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-api-context";
import { buildRelayPairingUriFromOfferUrl } from "@/utils/pairing-uri";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * t34 onboarding done-step QR: the daemon's local pairing offer rendered as a
 * large scannable code for the aaswitch mini-program. The QR and the copy
 * button carry the same `relay://` URI the mini-program's pair page parses
 * (relay E2EE straight to this daemon — no hub hop), derived from the same
 * `daemon-pairing-offer` cache entry the Settings pair-device sheet uses.
 */
export function ConnectPhoneQr({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const { isDisconnected, supportsPairingRpc, canConfigureRelay, pairingQuery, enableRelay } =
    useDaemonPairingOffer(serverId ?? "");

  const relayUri = useMemo(
    () => (pairingQuery.data?.url ? buildRelayPairingUriFromOfferUrl(pairingQuery.data.url) : null),
    [pairingQuery.data?.url],
  );

  const qrQuery = useFetchQuery({
    queryKey: ["daemon-pairing-offer-qr-relay", relayUri],
    queryFn: () =>
      QRCode.toString(relayUri ?? "", {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
      }),
    enabled: Boolean(relayUri),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
  });

  const handleRetry = useCallback(() => {
    void pairingQuery.refetch();
  }, [pairingQuery]);
  const handleEnableRelay = useCallback(() => {
    enableRelay.mutate();
  }, [enableRelay]);

  if (!serverId) {
    return (
      <Alert
        size="sm"
        variant="warning"
        title={t("hubOnboarding.connect.waitingHost")}
        testID="onboarding-connect-waiting-host"
      />
    );
  }
  if (isDisconnected) {
    return (
      <ConnectPhoneError message={t("workspace.terminal.hostDisconnected")} onRetry={handleRetry} />
    );
  }
  if (supportsPairingRpc && pairingQuery.isPending) {
    return <ThemedLoadingSpinner size="small" uniProps={mutedSpinnerColor} />;
  }
  if (pairingQuery.isError) {
    return <ConnectPhoneError message={pairingQuery.error.message} onRetry={handleRetry} />;
  }
  if (!pairingQuery.data?.relayEnabled) {
    // Relay is the direct-connect transport for the pairing offer; without it
    // there is nothing to encode yet. Offer the one-tap enable (same consent
    // as the Settings pair-device sheet) instead of an empty tile.
    return (
      <View style={styles.consent} testID="onboarding-connect-relay-off">
        <Text style={styles.consentText}>{t("hubOnboarding.connect.relayOffHint")}</Text>
        {enableRelay.isError ? (
          <Alert size="sm" variant="error" description={enableRelay.error.message} />
        ) : null}
        {!canConfigureRelay ? (
          <Alert size="sm" variant="warning" description={t("pairing.device.updateRequired")} />
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={enableRelay.isPending}
            onPress={handleEnableRelay}
            testID="onboarding-connect-enable-relay"
          >
            {enableRelay.isError ? t("pairing.device.retry") : t("pairing.device.enableRelay")}
          </Button>
        )}
      </View>
    );
  }
  if (!relayUri) {
    return <ConnectPhoneError message={t("pairing.device.unavailable")} onRetry={handleRetry} />;
  }

  return <ConnectPhoneReady relayUri={relayUri} qrSvg={qrQuery.data ?? null} />;
}

function ConnectPhoneError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert size="sm" variant="error" description={message} testID="onboarding-connect-error">
      <Button variant="outline" size="sm" onPress={onRetry} testID="onboarding-connect-retry">
        {t("pairing.device.retry")}
      </Button>
    </Alert>
  );
}

function ConnectPhoneReady({ relayUri, qrSvg }: { relayUri: string; qrSvg: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(relayUri);
      setCopied(true);
      toast.copied(relayUri);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("hubOnboarding.commandCopyFailed"));
    }
  }, [relayUri, t, toast]);
  const handleCopyPress = useCallback(() => {
    void handleCopy();
  }, [handleCopy]);

  return (
    <View style={styles.block} testID="onboarding-connect-qr">
      <View style={styles.qrTile} testID="onboarding-connect-qr-tile">
        {qrSvg ? (
          <SvgXml
            xml={qrSvg}
            width="100%"
            height="100%"
            accessibilityRole="image"
            accessibilityLabel={t("hubOnboarding.connect.qrAccessibility")}
          />
        ) : (
          <ThemedLoadingSpinner size="small" uniProps={mutedSpinnerColor} />
        )}
      </View>
      <Pressable
        style={styles.copyChip}
        onPress={handleCopyPress}
        accessibilityRole="button"
        accessibilityLabel={t("hubOnboarding.connect.copyLink")}
        testID="onboarding-connect-copy"
      >
        <Text style={styles.copyChipText} numberOfLines={1}>
          {copied ? t("pairing.device.copied") : t("hubOnboarding.connect.copyLink")}
        </Text>
      </Pressable>
      <Text style={styles.securityHint}>{t("hubOnboarding.connect.securityHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    alignItems: "center",
    gap: theme.spacing[3],
    width: "100%",
  },
  // White regardless of theme so the code stays scannable in dark mode; same
  // treatment as the Settings pair-device QR tile.
  qrTile: {
    width: 320,
    maxWidth: "100%",
    aspectRatio: 1,
    padding: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.white,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  consent: {
    width: "100%",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  consentText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    lineHeight: theme.fontSize.sm * 1.5,
  },
  copyChip: {
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.full,
  },
  copyChipText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  securityHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    lineHeight: theme.fontSize.sm * 1.5,
  },
}));
