import { defaultWebSocketFactory } from "@aaswitch/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@aaswitch/client/internal/daemon-client-transport-types";

export function createAppWebSocketFactory(): WebSocketFactory {
  return defaultWebSocketFactory;
}
