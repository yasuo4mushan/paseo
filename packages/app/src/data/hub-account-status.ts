import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HubAccountStatus } from "@aaswitch/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

/** Shared hub-account status query: the Settings account page, the t29
 * onboarding, and the sidebar login entry all read one cache entry. */
export const hubAccountStatusQueryKey = (serverId: string) =>
  ["hub-account-status", serverId] as const;

export interface UseHubAccountStatusResult {
  status: HubAccountStatus | null;
  /** True once the hub account RPCs are confirmed supported by this host. */
  supported: boolean;
  connected: boolean;
  client: ReturnType<typeof useHostRuntimeClient>;
  invalidate: () => void;
}

export function useHubAccountStatus(serverId: string): UseHubAccountStatusResult {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "hubAccountRpc");
  const queryClient = useQueryClient();

  const statusQuery = useFetchQuery({
    queryKey: hubAccountStatusQueryKey(serverId),
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: Boolean(client && connected && supported),
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      const result = await client.getHubAccountStatus();
      return result.status;
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: hubAccountStatusQueryKey(serverId) });
  }, [queryClient, serverId]);

  return {
    status: statusQuery.data ?? null,
    supported,
    connected,
    client,
    invalidate,
  };
}
