import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonGetPairingOfferResponse } from "@aaswitch/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";

export type DaemonPairingOffer = DaemonGetPairingOfferResponse["payload"];

/**
 * One source for the daemon's local pairing offer: the Settings pair-device
 * sheet, the onboarding done-step QR, and any future surface all share the
 * `daemon-pairing-offer` query cache entry for a given server.
 */
export function useDaemonPairingOffer(serverId: string): {
  isConnected: boolean;
  isDisconnected: boolean;
  supportsPairingRpc: boolean;
  canConfigureRelay: boolean;
  pairingQuery: UseQueryResult<DaemonPairingOffer, Error>;
  enableRelay: UseMutationResult<unknown, Error, void, unknown>;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const isConnected = runtimeSnapshot?.connectionStatus === "online";
  const isDisconnected =
    runtimeSnapshot?.connectionStatus === "offline" ||
    runtimeSnapshot?.connectionStatus === "error";
  const { patchConfig } = useDaemonConfig(serverId);
  const serverFeatures = client?.getLastServerInfoMessage()?.features;
  const supportsPairingRpc = serverFeatures?.daemonStatusRpc === true;
  const canConfigureRelay = supportsPairingRpc && serverFeatures?.relayConfig === true;

  const pairingQuery = useFetchQuery({
    queryKey: daemonPairingOfferQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getDaemonPairingOffer();
    },
    enabled: supportsPairingRpc && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    retry: 1,
  });

  const enableRelay = useMutation({
    mutationFn: async () => {
      if (client?.getLastServerInfoMessage()?.features?.relayConfig !== true) {
        throw new Error(t("pairing.device.updateRequired"));
      }
      const config = await patchConfig({ relay: { enabled: true } });
      if (!config) throw new Error(t("workspace.terminal.hostDisconnected"));
      return pairingQuery.refetch();
    },
  });

  return {
    isConnected,
    isDisconnected,
    supportsPairingRpc,
    canConfigureRelay,
    pairingQuery,
    enableRelay,
  };
}
