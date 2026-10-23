import { create } from "zustand";

/**
 * Session-scoped dismissal of the hub onboarding gate (t29).
 *
 * Not persisted on purpose: "skip for now" lasts for this app run only, so the
 * gate re-arms on the next launch and after a logout — the onboarding stays the
 * first-run surface until the daemon actually holds a hub login.
 */
interface HubOnboardingGateState {
  dismissed: boolean;
  dismiss: () => void;
  rearm: () => void;
}

export const useHubOnboardingGateStore = create<HubOnboardingGateState>((set) => ({
  dismissed: false,
  dismiss: () => set({ dismissed: true }),
  rearm: () => set({ dismissed: false }),
}));
