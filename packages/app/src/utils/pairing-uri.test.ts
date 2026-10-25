import { describe, expect, it } from "vitest";
import { parseRelayConnectionUri } from "@aaswitch/protocol/daemon-endpoints";
import { buildRelayPairingUriFromOffer, buildRelayPairingUriFromOfferUrl } from "./pairing-uri";

/**
 * Mirror of generateLocalPairingOffer's URL shape (server/src/pairing-offer.ts):
 * base64url(JSON.stringify(offer)) behind `#offer=`.
 */
function encodeOfferUrl(offer: Record<string, unknown>): string {
  const json = JSON.stringify(offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `https://app.example.com/#offer=${encoded}`;
}

describe("buildRelayPairingUriFromOfferUrl", () => {
  it("converts a daemon offer URL into a mini-program-parseable relay URI", () => {
    const url = encodeOfferUrl({
      v: 2,
      serverId: "srv_abc-123",
      daemonPublicKeyB64: "C9D/2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk=",
      relay: { endpoint: "192.168.2.202:6790", useTls: false },
    });

    const uri = buildRelayPairingUriFromOfferUrl(url);
    expect(uri).toBe(
      "relay://192.168.2.202:6790/srv_abc-123?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D",
    );

    // Round-trip through the protocol parser the CLI uses.
    const parsed = parseRelayConnectionUri(uri!);
    expect(parsed.offer.serverId).toBe("srv_abc-123");
    expect(parsed.offer.daemonPublicKeyB64).toBe("C9D/2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk=");
    expect(parsed.offer.relay.endpoint).toBe("192.168.2.202:6790");
    expect(parsed.offer.relay.useTls).toBe(false);
  });

  it("keeps the ssl flag for TLS relays", () => {
    const url = encodeOfferUrl({
      v: 2,
      serverId: "srv_tls",
      daemonPublicKeyB64: "pubkey",
      relay: { endpoint: "relay.example.com:443", useTls: true },
    });
    expect(buildRelayPairingUriFromOfferUrl(url)).toBe(
      "relay://relay.example.com:443/srv_tls?key=pubkey&ssl=true",
    );
  });

  it("returns null for URLs without an #offer= fragment", () => {
    expect(buildRelayPairingUriFromOfferUrl("https://app.example.com/")).toBeNull();
    expect(buildRelayPairingUriFromOfferUrl("")).toBeNull();
  });
});

describe("buildRelayPairingUriFromOffer", () => {
  it("URL-encodes the public key so the base64 padding survives the fragment", () => {
    const uri = buildRelayPairingUriFromOffer({
      v: 2,
      serverId: "srv_x",
      daemonPublicKeyB64: "a+b/c=",
      relay: { endpoint: "h:1", useTls: false },
    });
    expect(uri).toBe("relay://h:1/srv_x?key=a%2Bb%2Fc%3D");
    expect(parseRelayConnectionUri(uri).offer.daemonPublicKeyB64).toBe("a+b/c=");
  });
});
