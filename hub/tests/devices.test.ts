import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, registerAndLogin, startHub, validOffer, type TestHub } from "./helpers/hub.js";

let hub: TestHub;

beforeAll(async () => {
  // Short online window so online/offline transitions are testable.
  hub = await startHub({ onlineTtlMs: 200 });
});

afterAll(async () => {
  await hub.close();
});

async function registerDevice(url: string, token: string, name: string): Promise<string> {
  const res = await call(
    url,
    "devices.register",
    {
      name,
      os: "darwin",
      agent: "claude-code",
      offer: validOffer(),
    },
    token,
  );
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.json)}`);
  return (res.json.data as { deviceId: string }).deviceId;
}

describe("devices.register", () => {
  it("returns a dev_ id and shows up in devices.list", async () => {
    const token = await registerAndLogin(hub.url, "dev-owner");
    const deviceId = await registerDevice(hub.url, token, "mac-studio");
    expect(deviceId).toMatch(/^dev_/);

    const list = await call(hub.url, "devices.list", {}, token);
    expect(list.status).toBe(200);
    const devices = (list.json.data as { devices: unknown[] }).devices;
    expect(devices).toHaveLength(1);
    const device = devices[0] as Record<string, unknown>;
    // Fields the miniprogram device page renders directly.
    for (const field of ["deviceId", "name", "os", "agent", "offer", "online", "lastSeenAt"]) {
      expect(device[field], `device.${field}`).toBeDefined();
    }
    expect(device.online).toBe(true);
  });

  it("is idempotent per (account, name): same deviceId, offer replaced", async () => {
    const token = await registerAndLogin(hub.url, "idem-owner");
    const first = await call(
      hub.url,
      "devices.register",
      {
        name: "idem-box",
        os: "linux",
        offer: validOffer({ endpoint: "relay.one.example:443" }),
      },
      token,
    );
    const deviceId = (first.json.data as { deviceId: string }).deviceId;
    expect((first.json.data as { updated: boolean }).updated).toBe(false);

    const second = await call(
      hub.url,
      "devices.register",
      {
        name: "idem-box",
        os: "linux",
        offer: validOffer({ endpoint: "relay.two.example:443" }),
      },
      token,
    );
    expect((second.json.data as { deviceId: string }).deviceId).toBe(deviceId);
    expect((second.json.data as { updated: boolean }).updated).toBe(true);

    const list = await call(hub.url, "devices.list", {}, token);
    const devices = (
      list.json.data as { devices: { deviceId: string; offer: { endpoint: string } }[] }
    ).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0].offer.endpoint).toBe("relay.two.example:443");
  });

  it("requires a bearer token", async () => {
    const res = await call(hub.url, "devices.register", {
      name: "x",
      os: "darwin",
      offer: validOffer(),
    });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.token_invalid");
  });

  const badOffers: [string, Record<string, unknown>][] = [
    ["empty serverId", validOffer({ serverId: "" })],
    [
      "missing serverId",
      (() => {
        const o = validOffer();
        delete o.serverId;
        return o;
      })(),
    ],
    [
      "31-byte public key",
      validOffer({ daemonPublicKeyB64: Buffer.alloc(31, 1).toString("base64") }),
    ],
    ["garbage public key", validOffer({ daemonPublicKeyB64: "!!!not-base64!!!" })],
    ["endpoint without port", validOffer({ endpoint: "relay.example.com" })],
    ["endpoint with bad port", validOffer({ endpoint: "relay.example.com:99999" })],
    ["endpoint with space", validOffer({ endpoint: "relay example.com:443" })],
    ["non-boolean useTls", validOffer({ useTls: "yes" })],
    ["missing offer", undefined as unknown as Record<string, unknown>],
  ];

  for (const [label, offer] of badOffers) {
    it(`rejects offer (${label}) with devices.offer_invalid`, async () => {
      const token = await registerAndLogin(
        hub.url,
        `offer-${label.replace(/\W+/g, "_")}`.slice(0, 32).toLowerCase(),
      );
      const body: Record<string, unknown> = { name: "bad-offer", os: "darwin" };
      if (offer !== undefined) body.offer = offer;
      const res = await call(hub.url, "devices.register", body, token);
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("devices.offer_invalid");
    });
  }

  it("accepts a 32-byte base64url public key and bracketed IPv6 endpoint", async () => {
    const token = await registerAndLogin(hub.url, "edge-offer-user");
    const key = Buffer.alloc(32, 9).toString("base64url");
    const res = await call(
      hub.url,
      "devices.register",
      {
        name: "edge-box",
        os: "linux",
        offer: validOffer({ daemonPublicKeyB64: key, endpoint: "[2001:db8::1]:443" }),
      },
      token,
    );
    expect(res.status).toBe(200);
  });
});

describe("devices.heartbeat", () => {
  it("refreshes lastSeenAt and flips online back on", async () => {
    const token = await registerAndLogin(hub.url, "hb-owner");
    const deviceId = await registerDevice(hub.url, token, "hb-box");

    await new Promise((resolve) => setTimeout(resolve, 300)); // exceed the 200ms TTL
    let list = await call(hub.url, "devices.list", {}, token);
    expect((list.json.data as { devices: { online: boolean }[] }).devices[0].online).toBe(false);

    const beat = await call(hub.url, "devices.heartbeat", { deviceId }, token);
    expect(beat.status).toBe(200);
    expect((beat.json.data as { ok: boolean }).ok).toBe(true);

    list = await call(hub.url, "devices.list", {}, token);
    expect((list.json.data as { devices: { online: boolean }[] }).devices[0].online).toBe(true);
  });

  it("replaces the offer when provided", async () => {
    const token = await registerAndLogin(hub.url, "hb-offer-owner");
    const deviceId = await registerDevice(hub.url, token, "hb-offer-box");
    const newKey = Buffer.alloc(32, 3).toString("base64");
    const res = await call(
      hub.url,
      "devices.heartbeat",
      {
        deviceId,
        offer: validOffer({ daemonPublicKeyB64: newKey, serverId: "srv_rotated" }),
      },
      token,
    );
    expect(res.status).toBe(200);

    const list = await call(hub.url, "devices.list", {}, token);
    const device = (
      list.json.data as { devices: { offer: { daemonPublicKeyB64: string; serverId: string } }[] }
    ).devices[0];
    expect(device.offer.daemonPublicKeyB64).toBe(newKey);
    expect(device.offer.serverId).toBe("srv_rotated");
  });

  it("404s for an unknown or foreign deviceId", async () => {
    const tokenA = await registerAndLogin(hub.url, "hb-a");
    const tokenB = await registerAndLogin(hub.url, "hb-b");
    const deviceIdA = await registerDevice(hub.url, tokenA, "hb-box-a");
    await registerDevice(hub.url, tokenB, "hb-box-b");

    const foreign = await call(hub.url, "devices.heartbeat", { deviceId: deviceIdA }, tokenB);
    expect(foreign.status).toBe(404);
    expect(foreign.json.error?.code).toBe("not_found");

    const unknown = await call(hub.url, "devices.heartbeat", { deviceId: "dev_nope" }, tokenA);
    expect(unknown.status).toBe(404);
  });
});

describe("devices.unregister", () => {
  it("removes the device, then 404s on repeat and on heartbeat", async () => {
    const token = await registerAndLogin(hub.url, "unreg-owner");
    const deviceId = await registerDevice(hub.url, token, "bye-box");

    const first = await call(hub.url, "devices.unregister", { deviceId }, token);
    expect(first.status).toBe(200);

    const again = await call(hub.url, "devices.unregister", { deviceId }, token);
    expect(again.status).toBe(404);

    const beat = await call(hub.url, "devices.heartbeat", { deviceId }, token);
    expect(beat.status).toBe(404);
  });

  it("cannot unregister another account's device", async () => {
    const tokenA = await registerAndLogin(hub.url, "unreg-a");
    const tokenB = await registerAndLogin(hub.url, "unreg-b");
    const deviceIdA = await registerDevice(hub.url, tokenA, "target-box");
    const res = await call(hub.url, "devices.unregister", { deviceId: deviceIdA }, tokenB);
    expect(res.status).toBe(404);
  });
});

describe("devices.list isolation", () => {
  it("only shows the caller's devices", async () => {
    const tokenA = await registerAndLogin(hub.url, "iso-a");
    const tokenB = await registerAndLogin(hub.url, "iso-b");
    await registerDevice(hub.url, tokenA, "iso-box-a1");
    await registerDevice(hub.url, tokenA, "iso-box-a2");
    await registerDevice(hub.url, tokenB, "iso-box-b1");

    const listA = await call(hub.url, "devices.list", {}, tokenA);
    const listB = await call(hub.url, "devices.list", {}, tokenB);
    const namesA = (listA.json.data as { devices: { name: string }[] }).devices.map((d) => d.name);
    const namesB = (listB.json.data as { devices: { name: string }[] }).devices.map((d) => d.name);
    expect(namesA).toEqual(["iso-box-a1", "iso-box-a2"]);
    expect(namesB).toEqual(["iso-box-b1"]);
  });
});
