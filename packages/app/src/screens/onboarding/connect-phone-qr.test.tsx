/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, toastMock, copyMock, pairingState } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { sm: 13, base: 15, lg: 16 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { lg: 8, xl: 12, full: 999 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      accent: "#07c160",
      palette: { white: "#ffffff" },
    },
  },
  toastMock: { copied: vi.fn(), error: vi.fn(), show: vi.fn() },
  copyMock: vi.fn(async () => undefined),
  pairingState: {
    isConnected: true,
    isDisconnected: false,
    supportsPairingRpc: true,
    canConfigureRelay: true,
    pairingQuery: {
      isPending: false,
      isError: false,
      error: null as Error | null,
      refetch: vi.fn(async () => ({ data: undefined })),
      data: null as { relayEnabled: boolean; url: string } | null,
    },
    enableRelay: { isPending: false, isError: false, error: null, mutate: vi.fn() },
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "web",
    select: (options: Record<string, unknown>) => options.web ?? options.default,
  },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        onClick: onPress,
        type: "button",
      },
      children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (t: unknown) => Record<string, unknown>) => factory(theme),
  },
  withUnistyles: (component: unknown) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-svg", () => ({
  SvgXml: (props: { xml: string }) =>
    React.createElement("div", { "data-testid": "svg-xml" }, props.xml),
}));

vi.mock("qrcode", () => ({
  toString: vi.fn(async () => "<svg>qr</svg>"),
}));

vi.mock("@/hooks/use-daemon-pairing-offer", () => ({
  useDaemonPairingOffer: () => pairingState,
}));

vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({ data: "<svg>qr</svg>", isError: false }),
}));

vi.mock("@/contexts/toast-api-context", () => ({
  useToast: () => toastMock,
}));

vi.mock("@/utils/copy-to-clipboard", () => ({
  copyToClipboard: copyMock,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    description,
    children,
    testID,
  }: {
    description?: string;
    children?: React.ReactNode;
    testID?: string;
  }) => React.createElement("div", { "data-testid": testID }, description, children),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { "data-testid": testID, onClick: onPress, type: "button" },
      children,
    ),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "spinner" }),
}));

import { ConnectPhoneQr } from "./connect-phone-qr";

// offer URL for {v:2, serverId:"srv_t", daemonPublicKeyB64:"pubkey", relay:{endpoint:"h:1"}}
const OFFER_URL = `https://app.example.com/#offer=${Buffer.from(
  JSON.stringify({
    v: 2,
    serverId: "srv_t",
    daemonPublicKeyB64: "pubkey",
    relay: { endpoint: "192.168.2.202:6790", useTls: false },
  }),
  "utf8",
).toString("base64url")}`;
const EXPECTED_URI = "relay://192.168.2.202:6790/srv_t?key=pubkey";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderQr(serverId: string | null = "srv-1") {
  act(() => {
    root?.render(React.createElement(ConnectPhoneQr, { serverId }));
  });
}

function element(id: string): HTMLElement {
  return document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
}

describe("ConnectPhoneQr (t34)", () => {
  it("shows the relay-off state with the one-tap enable action", () => {
    pairingState.pairingQuery.data = { relayEnabled: false, url: "" };
    renderQr();
    expect(element("onboarding-connect-relay-off")).not.toBeNull();
    expect(element("onboarding-connect-enable-relay")).not.toBeNull();
    act(() => {
      element("onboarding-connect-enable-relay").click();
    });
    expect(pairingState.enableRelay.mutate).toHaveBeenCalledTimes(1);
  });

  it("renders the large QR and copies the mini-program relay URI", async () => {
    pairingState.pairingQuery.data = { relayEnabled: true, url: OFFER_URL };
    renderQr();
    expect(element("onboarding-connect-qr")).not.toBeNull();
    expect(element("onboarding-connect-qr-tile")).not.toBeNull();
    expect(element("svg-xml")?.textContent).toBe("<svg>qr</svg>");
    await act(async () => {
      element("onboarding-connect-copy").click();
    });
    expect(copyMock).toHaveBeenCalledWith(EXPECTED_URI);
    expect(toastMock.copied).toHaveBeenCalledTimes(1);
  });

  it("shows the waiting state when no host is online yet", () => {
    renderQr(null);
    expect(element("onboarding-connect-waiting-host")).not.toBeNull();
  });

  it("surfaces offer errors with a retry action", () => {
    pairingState.pairingQuery.data = null;
    pairingState.pairingQuery.isError = true;
    pairingState.pairingQuery.error = new Error("boom");
    renderQr();
    expect(element("onboarding-connect-error")?.textContent).toContain("boom");
    act(() => {
      element("onboarding-connect-retry").click();
    });
    expect(pairingState.pairingQuery.refetch).toHaveBeenCalledTimes(1);
    pairingState.pairingQuery.isError = false;
    pairingState.pairingQuery.error = null;
  });
});
