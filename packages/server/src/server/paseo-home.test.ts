import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  legacyPaseoHomeCandidate,
  migrateLegacyPaseoHome,
  resolvePaseoHome,
} from "./paseo-home.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-home-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe("resolvePaseoHome", () => {
  test("resolves AASWITCH_HOME without creating it", () => {
    const parent = makeTempRoot();
    const home = path.join(parent, "home");
    expect(resolvePaseoHome({ AASWITCH_HOME: home })).toBe(home);
    expect(existsSync(home)).toBe(false);
  });

  test("defaults to ~/.aaswitch", () => {
    expect(resolvePaseoHome({})).toBe(path.join(homedir(), ".aaswitch"));
  });

  // COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
  test("falls back to legacy PASEO_HOME when AASWITCH_HOME is unset", () => {
    const parent = makeTempRoot();
    const legacyHome = path.join(parent, "legacy");
    expect(resolvePaseoHome({ PASEO_HOME: legacyHome })).toBe(legacyHome);
  });

  test("AASWITCH_HOME wins when both spellings are set", () => {
    const parent = makeTempRoot();
    expect(resolvePaseoHome({ AASWITCH_HOME: path.join(parent, "new"), PASEO_HOME: "/old" })).toBe(
      path.join(parent, "new"),
    );
  });
});

describe("legacyPaseoHomeCandidate", () => {
  test("maps the default user home pair", () => {
    expect(legacyPaseoHomeCandidate(path.join(homedir(), ".aaswitch"))).toBe(
      path.join(homedir(), ".paseo"),
    );
  });

  test("maps dev checkout homes by basename", () => {
    expect(legacyPaseoHomeCandidate("/repo/.dev/aaswitch-home")).toBe("/repo/.dev/paseo-home");
  });

  test("leaves custom homes alone", () => {
    expect(legacyPaseoHomeCandidate("/custom/data")).toBeNull();
    expect(legacyPaseoHomeCandidate(path.join(homedir(), "aaswitch"))).toBeNull();
  });
});

function seedLegacyHome(legacyHome: string): void {
  mkdirSync(path.join(legacyHome, "agents"), { recursive: true });
  writeFileSync(path.join(legacyHome, "config.json"), '{"version":1}');
  writeFileSync(path.join(legacyHome, "server-id"), "server-migrated");
  writeFileSync(path.join(legacyHome, "paseo.pid"), JSON.stringify({ pid: 1 }));
  writeFileSync(path.join(legacyHome, "agents", "agent-1.json"), '{"name":"agent-1"}');
}

function expectHomeMigrated(from: string, to: string): void {
  expect(existsSync(to)).toBe(true);
  expect(existsSync(path.join(to, "config.json"))).toBe(true);
  expect(existsSync(path.join(to, "server-id"))).toBe(true);
  expect(existsSync(path.join(to, "agents", "agent-1.json"))).toBe(true);
  expect(readFileSync(path.join(to, "server-id"), "utf8")).toBe("server-migrated");
  expect(existsSync(from)).toBe(false);
}

describe("migrateLegacyPaseoHome", () => {
  test("renames a legacy dev home onto the new name with contents intact", () => {
    const root = makeTempRoot();
    const legacyHome = path.join(root, "paseo-home");
    const home = path.join(root, "aaswitch-home");
    seedLegacyHome(legacyHome);

    const result = migrateLegacyPaseoHome(home);

    expect(result).toEqual({ action: "migrated", from: legacyHome, to: home, copied: false });
    expectHomeMigrated(legacyHome, home);
  });

  test("never migrates when the new home already exists", () => {
    const root = makeTempRoot();
    const legacyHome = path.join(root, "paseo-home");
    const home = path.join(root, "aaswitch-home");
    seedLegacyHome(legacyHome);
    mkdirSync(home);
    writeFileSync(path.join(home, "config.json"), '{"version":2}');

    const result = migrateLegacyPaseoHome(home);

    expect(result).toEqual({ action: "none" });
    expect(existsSync(legacyHome)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
      version: 2,
    });
  });

  test("does nothing when no legacy home exists", () => {
    const root = makeTempRoot();
    expect(migrateLegacyPaseoHome(path.join(root, "aaswitch-home"))).toEqual({ action: "none" });
  });

  test("does nothing for a custom home without a known predecessor", () => {
    const root = makeTempRoot();
    mkdirSync(path.join(root, "anything-else"));
    expect(migrateLegacyPaseoHome(path.join(root, "custom"))).toEqual({ action: "none" });
  });

  test("skips migration while the legacy home hosts a running daemon", () => {
    const root = makeTempRoot();
    const legacyHome = path.join(root, "paseo-home");
    const home = path.join(root, "aaswitch-home");
    seedLegacyHome(legacyHome);

    const result = migrateLegacyPaseoHome(home, { isLegacyHomeInUse: () => true });

    expect(result).toEqual({
      action: "skipped",
      from: legacyHome,
      to: home,
      reason: "legacy_in_use",
    });
    expect(existsSync(legacyHome)).toBe(true);
    expect(existsSync(home)).toBe(false);
  });

  test("falls back to a copy when rename fails across filesystems", () => {
    const root = makeTempRoot();
    const legacyHome = path.join(root, "paseo-home");
    const home = path.join(root, "aaswitch-home");
    seedLegacyHome(legacyHome);

    const result = migrateLegacyPaseoHome(home, {
      renameImpl: () => {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      },
      copyImpl: (from, to) => cpSync(from, to, { recursive: true }),
    });

    expect(result).toEqual({ action: "migrated", from: legacyHome, to: home, copied: true });
    expect(existsSync(path.join(home, "agents", "agent-1.json"))).toBe(true);
    expect(readFileSync(path.join(home, "server-id"), "utf8")).toBe("server-migrated");
    // A copy fallback keeps the legacy directory as a backup.
    expect(existsSync(legacyHome)).toBe(true);
  });

  test("treats a rename race (legacy vanished, new present) as migrated", () => {
    const root = makeTempRoot();
    const legacyHome = path.join(root, "paseo-home");
    const home = path.join(root, "aaswitch-home");
    seedLegacyHome(legacyHome);

    const result = migrateLegacyPaseoHome(home, {
      renameImpl: () => {
        // Another process completed the migration between our check and the
        // rename: the legacy directory is gone and the new home exists.
        rmSync(legacyHome, { recursive: true, force: true });
        mkdirSync(home);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      copyImpl: () => {
        throw new Error("copy should not run");
      },
    });

    expect(result).toEqual({ action: "migrated", from: legacyHome, to: home, copied: false });
  });
});
