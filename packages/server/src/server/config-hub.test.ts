import { describe, expect, test } from "vitest";

import { DEFAULT_HUB_BASE_URL, normalizeHubBaseUrl, resolveConfigFromPersisted } from "./config.js";
import type { PersistedConfig } from "./persisted-config.js";

describe("hub account config resolution", () => {
  test("normalizes pasted hub base URLs", () => {
    expect(normalizeHubBaseUrl("http://hub.example.cn")).toBe("http://hub.example.cn");
    expect(normalizeHubBaseUrl("http://hub.example.cn/")).toBe("http://hub.example.cn");
    expect(normalizeHubBaseUrl("http://hub.example.cn///")).toBe("http://hub.example.cn");
    expect(normalizeHubBaseUrl("http://hub.example.cn/api")).toBe("http://hub.example.cn");
    expect(normalizeHubBaseUrl("http://hub.example.cn/api/")).toBe("http://hub.example.cn");
    expect(normalizeHubBaseUrl("https://hub.example.cn/api")).toBe("https://hub.example.cn");
    expect(normalizeHubBaseUrl("  ")).toBeNull();
    expect(normalizeHubBaseUrl(undefined)).toBeNull();
  });

  test("resolves hub credentials from the persisted config", () => {
    const persisted = {
      version: 1,
      hub: {
        baseUrl: "http://hub.example.cn",
        token: "persisted-token",
        username: "alice",
        deviceName: "mac-studio",
      },
    } as PersistedConfig;
    const config = resolveConfigFromPersisted("/tmp/paseo-home", persisted, { env: {} });
    expect(config.hub).toEqual({
      baseUrl: "http://hub.example.cn",
      token: "persisted-token",
      username: "alice",
      deviceName: "mac-studio",
      tokenFromEnv: false,
    });
  });

  test("environment overrides win over persisted values and mark the token env-controlled", () => {
    const persisted = {
      version: 1,
      hub: { baseUrl: "http://persisted.example.cn", token: "persisted-token" },
    } as PersistedConfig;
    const config = resolveConfigFromPersisted("/tmp/paseo-home", persisted, {
      env: {
        PASEO_HUB_URL: "http://env.example.cn/api",
        PASEO_HUB_TOKEN: "env-token",
      },
    });
    expect(config.hub).toEqual({
      baseUrl: "http://env.example.cn",
      token: "env-token",
      username: null,
      deviceName: null,
      tokenFromEnv: true,
    });
  });

  test("an empty env value falls back to the persisted config", () => {
    const persisted = {
      version: 1,
      hub: { baseUrl: "http://hub.example.cn", token: "persisted-token" },
    } as PersistedConfig;
    const config = resolveConfigFromPersisted("/tmp/paseo-home", persisted, {
      env: { PASEO_HUB_URL: "  ", PASEO_HUB_TOKEN: "" },
    });
    expect(config.hub).toMatchObject({
      baseUrl: "http://hub.example.cn",
      token: "persisted-token",
      tokenFromEnv: false,
    });
  });

  test("no hub configuration resolves to the built-in default base URL", () => {
    const config = resolveConfigFromPersisted(
      "/tmp/paseo-home",
      { version: 1 } as PersistedConfig,
      {
        env: {},
      },
    );
    // Zero-config sign-in: the default makes the daemon usable without any
    // hub address persisted or set in the environment.
    expect(normalizeHubBaseUrl(DEFAULT_HUB_BASE_URL)).toBe(
      "http://remoteagent.agentsworkforyou.cn",
    );
    expect(config.hub).toEqual({
      baseUrl: "http://remoteagent.agentsworkforyou.cn",
      token: null,
      username: null,
      deviceName: null,
      tokenFromEnv: false,
    });
  });

  test("env hub overrides are reported as override-controlled paths", () => {
    const persisted = { version: 1 } as PersistedConfig;
    const withEnv = resolveConfigFromPersisted("/tmp/paseo-home", persisted, {
      env: { PASEO_HUB_URL: "http://env.example.cn", PASEO_HUB_TOKEN: "env-token" },
    });
    expect(withEnv.configReload?.overrideControlledPaths).toEqual(
      expect.arrayContaining(["hub.baseUrl", "hub.token"]),
    );

    const withoutEnv = resolveConfigFromPersisted("/tmp/paseo-home", persisted, { env: {} });
    expect(withoutEnv.configReload?.overrideControlledPaths).not.toContain("hub.baseUrl");
  });
});
