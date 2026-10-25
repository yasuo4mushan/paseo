/**
 * ZCode executable discovery.
 *
 * The ZCode app-server ships inside the Z.ai ZCode desktop app on macOS and is
 * not usually on PATH. Three launch strategies, in priority order:
 *
 *   1. A `command` override in config (`agents.providers.zcode.command`) —
 *      replaces the default command entirely (handled by resolveProviderLaunch).
 *   2. A `zcode` binary on PATH (`zcode app-server`).
 *   3. The macOS desktop-app bundle: `node <ZCode.app>/Contents/Resources/glm/
 *      zcode.cjs app-server` (login state is shared with the desktop app).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import {
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../provider-launch-config.js";

export const ZCODE_BINARY_NAME = "zcode";
export const ZCODE_APP_SERVER_ARG = "app-server";

/** macOS desktop-app bundle layout (verified against ZCode 0.16.9). */
export const ZCODE_MACOS_APP_CJS_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

/**
 * Cross-platform ZCode desktop-app bundle discovery. The app-server only
 * ships inside the desktop app, and users install it in many places:
 *
 *   - macOS: /Applications, ~/Applications, and any mounted volume's
 *     Applications dir (users move big apps off the system volume).
 *   - Windows: per-user (%LOCALAPPDATA%\Programs) and both Program Files.
 *   - Linux: /opt and ~/.local/share.
 *
 * AASWITCH_ZCODE_APP overrides with an explicit install root (the directory
 * that CONTAINS resources/glm/zcode.cjs) for exotic layouts.
 * COMPAT(paseoNames): the PASEO_ZCODE_APP alias is read for one window.
 */
export function candidateZcodeAppBundleCjsPaths(): string[] {
  const paths: string[] = [];
  const override =
    process.env.AASWITCH_ZCODE_APP ??
    // COMPAT(paseoNames): added in v1.0, remove after 2027-04-30
    process.env.PASEO_ZCODE_APP;
  if (override) {
    // Accept either the install root (…/ZCode) or a bundle path (…/ZCode.app).
    paths.push(path.join(override, "resources", "glm", "zcode.cjs"));
    paths.push(path.join(override, "Contents", "Resources", "glm", "zcode.cjs"));
  }
  const installRoots: Array<string> = [];
  const home = os.homedir();
  if (process.platform === "win32") {
    installRoots.push(
      path.join(home, "AppData", "Local", "Programs", "ZCode"),
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ZCode"),
      path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "ZCode"),
    );
  } else if (process.platform === "darwin") {
    const appRoots = ["/Applications", path.join(home, "Applications")];
    try {
      for (const dir of fs.readdirSync("/Volumes")) {
        appRoots.push(path.join("/Volumes", dir, "Applications"));
      }
    } catch {
      // /Volumes unreadable — fall back to the standard roots only.
    }
    for (const root of appRoots) {
      installRoots.push(path.join(root, "ZCode.app", "Contents", "Resources"));
    }
  } else {
    installRoots.push(
      "/opt/ZCode/resources",
      path.join(home, ".local", "share", "ZCode", "resources"),
    );
  }
  for (const root of installRoots) {
    paths.push(path.join(root, "glm", "zcode.cjs"));
  }
  return paths;
}

export interface ZcodeLaunch {
  command: string;
  args: string[];
  source: "path" | "app-bundle" | "override" | "append" | "unavailable";
}

export async function resolveZcodeLaunch(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<ZcodeLaunch> {
  const commandConfig = runtimeSettings?.command;
  const launch: ResolvedProviderLaunch = await resolveProviderLaunch({
    commandConfig,
    defaultBinary: ZCODE_BINARY_NAME,
  });

  if (launch.source === "override") {
    return {
      command: launch.command,
      args: [...launch.args, ZCODE_APP_SERVER_ARG],
      source: "override",
    };
  }

  const extraArgs = launch.source === "append" ? launch.args : [];
  const discovered = await discoverDefaultZcodeLaunch();
  if (!discovered) {
    return {
      command: ZCODE_BINARY_NAME,
      args: [...extraArgs, ZCODE_APP_SERVER_ARG],
      source: "unavailable",
    };
  }
  return {
    ...discovered,
    args: [...discovered.args, ...extraArgs, ZCODE_APP_SERVER_ARG],
    source: launch.source === "append" ? "append" : discovered.source,
  };
}

async function discoverDefaultZcodeLaunch(): Promise<{
  command: string;
  args: string[];
  source: "path" | "app-bundle";
} | null> {
  const onPath = await findExecutable(ZCODE_BINARY_NAME);
  if (onPath) {
    return { command: onPath, args: [], source: "path" };
  }
  const bundleCjs = existingZcodeAppBundleCjs();
  if (bundleCjs) {
    // The bundle only ships the .cjs entry; run it with the current node.
    return {
      command: process.execPath,
      args: [bundleCjs],
      source: "app-bundle",
    };
  }
  return null;
}

export function zcodeAppBundleCjsExists(): boolean {
  try {
    return candidateZcodeAppBundleCjsPaths().some((candidate) => fs.statSync(candidate).isFile());
  } catch {
    return false;
  }
}

/** The first bundle .cjs that exists, for launching with the current node. */
export function existingZcodeAppBundleCjs(): string | null {
  for (const candidate of candidateZcodeAppBundleCjsPaths()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable candidate — try the next root
    }
  }
  return null;
}

export async function isZcodeLaunchAvailable(runtimeSettings?: ProviderRuntimeSettings): Promise<{
  available: boolean;
  launch: ZcodeLaunch;
}> {
  const launch = await resolveZcodeLaunch(runtimeSettings);
  if (launch.source === "override") {
    // Absolute paths can be checked directly; bare names need PATH resolution.
    if (path.isAbsolute(launch.command)) {
      try {
        return { available: fs.statSync(launch.command).isFile(), launch };
      } catch {
        return { available: false, launch };
      }
    }
    return { available: (await findExecutable(launch.command)) !== null, launch };
  }
  return { available: launch.source === "path" || launch.source === "app-bundle", launch };
}

export function describeZcodeLaunchSource(launch: ZcodeLaunch): string {
  switch (launch.source) {
    case "path":
      return `zcode on PATH (${launch.command})`;
    case "app-bundle":
      return `ZCode desktop app bundle (${launch.args[0] ?? "unknown path"})`;
    case "override":
      return `configured command override (${[launch.command, ...launch.args].join(" ")})`;
    case "append":
      return "default launch with configured extra args";
    default:
      return "not found";
  }
}
