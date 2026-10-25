import {
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@aaswitch/protocol/connection-offer";

/**
 * Daemon pairing offer URL → `relay://` pairing URI.
 *
 * The daemon's `daemon.get_pairing_offer` returns an `https://…/#offer=<base64url>`
 * URL whose payload only the native app deep link understands. The aaswitch
 * mini-program's parser (miniprogram/src/connection/relay-offer.ts) and the CLI's
 * `Connection URI` line both speak `relay://host:port/serverId?key=<pubkey>[&ssl=true]`,
 * so QR codes aimed at the mini-program encode that form. Semantics mirror
 * `serializeRelayConnectionUri` in @aaswitch/protocol without its `URL` dependency
 * (Hermes has no WHATWG URL); `parseRelayConnectionUri` round-trips the result.
 */
export function buildRelayPairingUriFromOfferUrl(offerUrl: string): string | null {
  const offer = parseConnectionOfferFromUrl(offerUrl);
  return offer ? buildRelayPairingUriFromOffer(offer) : null;
}

export function buildRelayPairingUriFromOffer(offer: ConnectionOffer): string {
  const query = [`key=${encodeURIComponent(offer.daemonPublicKeyB64)}`];
  if (offer.relay.useTls) query.push("ssl=true");
  return `relay://${offer.relay.endpoint}/${encodeURIComponent(offer.serverId)}?${query.join("&")}`;
}
