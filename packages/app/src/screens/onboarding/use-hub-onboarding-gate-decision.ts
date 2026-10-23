import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { useEarliestOnlineHostServerId } from "@/app/_layout";
import { useHubAccountStatus } from "@/data/hub-account-status";
import { isWeb } from "@/constants/platform";
import {
  resolveHubOnboardingGate,
  type HubOnboardingGateDecision,
} from "@/screens/onboarding/hub-onboarding-gate";
import { useHubOnboardingGateStore } from "@/screens/onboarding/hub-onboarding-gate-store";

/** Bounded startup wait for `hub.status` — the gate never blocks startup. */
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 4_000;

/** False only once server_info proved the host lacks the hub account RPCs. */
function resolveHubSupported(
  serverId: string | null,
  serverInfoLoaded: boolean,
  featureFlag: boolean,
): boolean | null {
  if (serverId === null) return false;
  if (serverInfoLoaded) return featureFlag;
  return null;
}

/**
 * Assembles the t29 onboarding gate decision for the primary (earliest
 * online) host. `server_info` availability is tri-state so a host whose
 * features have not arrived yet reads as "pending", not "unsupported".
 */
export function useHubOnboardingGateDecision(options?: {
  statusWaitTimeoutMs?: number;
}): HubOnboardingGateDecision {
  const serverId = useEarliestOnlineHostServerId();
  const { status, connected } = useHubAccountStatus(serverId ?? "");
  const dismissed = useHubOnboardingGateStore((state) => state.dismissed);

  // Tri-state feature probe: null until server_info arrives.
  const serverInfoLoaded = useSessionStore((state) => {
    if (!serverId) return false;
    return Boolean(state.sessions[serverId]?.serverInfo);
  });
  const hubSupportedFlag = useHostFeature(serverId, "hubAccountRpc");
  const hubSupported = resolveHubSupported(serverId, serverInfoLoaded, hubSupportedFlag);

  const pending =
    !dismissed &&
    (serverId === null ||
      !connected ||
      hubSupported === null ||
      (hubSupported === true && status === null));
  const [statusWaitExpired, setStatusWaitExpired] = useState(false);
  useEffect(() => {
    if (!pending) {
      setStatusWaitExpired(false);
      return;
    }
    const timer = setTimeout(
      () => setStatusWaitExpired(true),
      options?.statusWaitTimeoutMs ?? DEFAULT_STATUS_WAIT_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [pending, options?.statusWaitTimeoutMs]);

  return useMemo(
    () =>
      resolveHubOnboardingGate({
        platformEligible: isWeb,
        hubSupported,
        connected,
        status,
        dismissedThisSession: dismissed,
        statusWaitExpired,
      }),
    [hubSupported, connected, status, dismissed, statusWaitExpired],
  );
}
