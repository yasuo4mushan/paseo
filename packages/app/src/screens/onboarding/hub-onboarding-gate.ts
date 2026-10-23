import type { HubAccountStatus } from "@getpaseo/protocol/messages";

/**
 * t29 first-run onboarding gate (Web/desktop).
 *
 * The gate decides whether the startup route holds the user in the onboarding
 * flow. It is a pure decision over inputs that the calling hook assembles, so
 * every branch is unit-testable without a daemon:
 *
 * - "ineligible": native app — the hub onboarding is a Web/desktop surface.
 * - "pass": proceed into the app (already logged in, dismissed this session,
 *   old host without `hubAccountRpc`, or the status check gave up waiting so
 *   startup is never blocked on a slow hub).
 * - "pending": keep showing the splash until the inputs resolve.
 * - "onboarding": not logged in — route to `/onboarding`.
 */
export type HubOnboardingGateDecision = "ineligible" | "pass" | "pending" | "onboarding";

export interface ResolveHubOnboardingGateInput {
  /** Web runtime (browser or Electron desktop) — the onboarding platform. */
  platformEligible: boolean;
  /** `server_info.features.hubAccountRpc`; null while server info is loading. */
  hubSupported: boolean | null;
  connected: boolean;
  /** Hub account status; null until the first `hub.status` response. */
  status: HubAccountStatus | null;
  /** Session-level skip via the "use locally without signing in" action. */
  dismissedThisSession: boolean;
  /** The bounded startup wait for `hub.status` expired — never block startup. */
  statusWaitExpired: boolean;
}

export function resolveHubOnboardingGate(
  input: ResolveHubOnboardingGateInput,
): HubOnboardingGateDecision {
  if (!input.platformEligible) {
    return "ineligible";
  }
  if (input.dismissedThisSession) {
    return "pass";
  }
  // Old host without the account RPCs: show the app as before. The Settings
  // account page keeps its own "update the host" notice.
  if (input.hubSupported === false) {
    return "pass";
  }
  if (!input.connected) {
    return input.statusWaitExpired ? "pass" : "pending";
  }
  if (input.hubSupported === null || input.status === null) {
    return input.statusWaitExpired ? "pass" : "pending";
  }
  return input.status.loggedIn ? "pass" : "onboarding";
}
