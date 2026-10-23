/**
 * t30: pure state resolution for the Settings host-account page. Hub login and
 * register moved to first-run onboarding (t29), so the page renders exactly one
 * of these states — never a credentials form. Signed-out visitors get a card
 * that links back into `/onboarding`.
 */
export type HostAccountPageState =
  | "hostMissing"
  | "unsupported"
  | "disconnected"
  | "loading"
  | "signedIn"
  | "signedOut";

export function resolveHostAccountPageState(input: {
  hostExists: boolean;
  supported: boolean;
  connected: boolean;
  status: { loggedIn: boolean } | null;
}): HostAccountPageState {
  if (!input.hostExists) return "hostMissing";
  if (!input.supported) return "unsupported";
  if (!input.connected) return "disconnected";
  if (input.status === null) return "loading";
  return input.status.loggedIn ? "signedIn" : "signedOut";
}
