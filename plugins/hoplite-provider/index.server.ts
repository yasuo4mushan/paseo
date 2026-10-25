import type { PluginServerContext } from "@aaswitch/plugin/server";
import { createHopliteProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createHopliteProvider());
  return () => {};
}
