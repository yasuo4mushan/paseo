/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

const { theme, toastMock, copyMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { sm: 13, base: 15, lg: 16 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { lg: 8, xl: 12 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      accent: "#0a84ff",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
    },
  },
  toastMock: { copied: vi.fn(), error: vi.fn(), show: vi.fn() },
  copyMock: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
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
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
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
      typeof children === "function" ? children({ hovered: false, pressed: false }) : children,
    ),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  ActivityIndicator: () => React.createElement("span", { "data-testid": "spinner" }),
}));

vi.mock("react-native-unistyles", () => ({
  useUnistyles: () => ({ theme }),
  StyleSheet: {
    create: (factory: (t: unknown) => Record<string, unknown>) => factory(theme),
  },
  withUnistyles: (component: unknown) => component,
}));

vi.mock("lucide-react-native", () => ({
  Check: (props: { testID?: string }) => React.createElement("span", props),
  Copy: (props: { testID?: string }) => React.createElement("span", props),
  RotateCw: (props: { testID?: string }) => React.createElement("span", props),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/app/_layout", () => ({
  useEarliestOnlineHostServerId: () => "srv-1",
}));

vi.mock("@/components/provider-icons", () => ({
  useProviderIcons: () => (provider: string) => {
    const Icon = (props: { size?: number; color?: string }) =>
      React.createElement("span", { "data-testid": `icon-${provider}`, ...props });
    return Icon;
  },
}));

vi.mock("@/contexts/toast-api-context", () => ({
  useToast: () => toastMock,
}));

vi.mock("@/utils/copy-to-clipboard", () => ({
  copyToClipboard: copyMock,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title }: { title: string }) => React.createElement("div", null, title),
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

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  FormTextInput: () => React.createElement("input", { type: "text" }),
}));

vi.mock("@/components/icons/paseo-logo", () => ({
  PaseoLogo: () => React.createElement("div", { "data-testid": "paseo-logo" }),
}));

vi.mock("@/data/hub-account-status", () => ({
  useHubAccountStatus: () => ({
    status: null,
    supported: true,
    connected: true,
    client: null,
    invalidate: () => undefined,
  }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: undefined,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: async () => undefined,
    refetchIfStale: () => undefined,
  }),
}));

vi.mock("@/screens/onboarding/hub-onboarding-gate-store", () => ({
  useHubOnboardingGateStore: (selector: (state: { dismissed: boolean }) => boolean) =>
    selector({ dismissed: false }),
}));

import { ChecklistRow } from "./hub-onboarding-screen";
import { buildProviderChecklistRows } from "./provider-checklist";

function entry(
  provider: string,
  status: ProviderSnapshotEntry["status"],
  overrides: Partial<ProviderSnapshotEntry> = {},
): ProviderSnapshotEntry {
  return { provider, status, ...overrides } as ProviderSnapshotEntry;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // Classic JSX runtime in app sources: components reference the React global.
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function renderRow(row: ReturnType<typeof buildProviderChecklistRows>[number]): void {
  act(() => {
    root?.render(
      React.createElement(ChecklistRow, { row, serverId: "srv-1", testID: `row-${row.provider}` }),
    );
  });
}

describe("ChecklistRow rendering (t29)", () => {
  it("renders the ready state with the zcode ready hint and no command", () => {
    const [zcodeRow] = buildProviderChecklistRows([entry("zcode", "ready")]);
    renderRow(zcodeRow);
    expect(container?.textContent).toContain("hubOnboarding.providers.states.ready");
    expect(container?.textContent).toContain("hubOnboarding.providers.zcodeReady");
    expect(container?.querySelector('[data-testid="row-zcode-command"]')).toBeNull();
  });

  it("renders the needs-login state with the login command chip and copy button", () => {
    const rows = buildProviderChecklistRows([entry("kimi", "error", { error: "not logged in" })]);
    const kimiRow = rows.find((row) => row.provider === "kimi");
    renderRow(kimiRow!);
    expect(container?.textContent).toContain("hubOnboarding.providers.states.needsLogin");
    expect(container?.textContent).toContain("kimi login");
    expect(container?.textContent).toContain("hubOnboarding.providers.loginHint");
    const copyButton = container?.querySelector('[data-testid="row-kimi-command-copy"]');
    expect(copyButton).not.toBeNull();
    act(() => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(copyMock).toHaveBeenCalledWith("kimi login");
  });

  it("renders the not-installed state with the install command", () => {
    const rows = buildProviderChecklistRows([entry("qwen-code", "unavailable")]);
    renderRow(rows.find((row) => row.provider === "qwen-code")!);
    expect(container?.textContent).toContain("hubOnboarding.providers.states.notInstalled");
    expect(container?.textContent).toContain("npm i -g @qwen-code/qwen-code");
    expect(container?.textContent).toContain("hubOnboarding.providers.installHint");
  });

  it("renders a ready non-zcode provider without the zcode hint", () => {
    const rows = buildProviderChecklistRows([entry("kimi", "ready")]);
    renderRow(rows.find((row) => row.provider === "kimi")!);
    expect(container?.textContent).not.toContain("zcodeReady");
  });
});
