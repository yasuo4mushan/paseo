import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as QRCode from "qrcode";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import {
  openSettingsHost,
  openSettingsHostSection,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

/**
 * t34 end-to-end (web side): the onboarding done step renders a large pairing
 * QR for the aaswitch mini-program, the Settings host page leads with a
 * Connect phone tile, and the copied link is exactly the `relay://` URI the
 * mini-program pair page parses.
 *
 * The daemon under test is the long-lived t34 harness daemon (started outside
 * the spec: relay 6780, mock hub 6782, daemon 6781) so the extracted URI can
 * be replayed by the mini-program automator afterwards. The URI is written to
 * T34_RELAY_URI_OUT for that phase.
 */
const DAEMON_PORT = Number(process.env.T34_DAEMON_PORT ?? 6781);
const SERVER_ID = process.env.T34_SERVER_ID ?? "t34_e2e_host";
const RELAY_URI_OUT = process.env.T34_RELAY_URI_OUT ?? "/tmp/t34/relay-uri.txt";
// Playwright runs with the app package as cwd; the QA evidence lives at the
// repo root (docs/qa.md evidence bar).
const SHOT_DIR = process.env.T34_SHOT_DIR ?? resolve(process.cwd(), "../../docs/screenshots");

const QR_OPTIONS = { type: "svg", errorCorrectionLevel: "M", margin: 1 } as const;

async function seedT34Host(page: Page): Promise<void> {
  await seedSavedSettingsHosts(page, [
    { serverId: SERVER_ID, label: "t34 pairing host", endpoint: `127.0.0.1:${DAEMON_PORT}` },
  ]);
}

async function advanceToDone(page: Page): Promise<void> {
  await expect(page.getByTestId("hub-onboarding-agents-next")).toBeVisible();
  await page.getByTestId("hub-onboarding-agents-next").click();
  await expect(page.getByTestId("hub-onboarding-step-done")).toBeVisible();
}

async function walkOnboardingToDone(page: Page): Promise<void> {
  await page.goto("/onboarding");
  await expect(page.getByTestId("hub-onboarding-screen")).toBeVisible();
  // A daemon that already holds a hub session starts on credentials and flips
  // to the checklist once the status query resolves. The flip beats any fixed
  // probe, so wait it out and only log in when it never comes.
  try {
    await expect(page.getByTestId("hub-onboarding-step-agents")).toBeVisible({
      timeout: 15_000,
    });
  } catch {
    // Mock-hub demo account login → device name → agent checklist.
    await page.getByTestId("hub-onboarding-phone-field").locator("input").fill("13800138000");
    await page.getByTestId("hub-onboarding-password-field").locator("input").fill("demo12345");
    await page.getByTestId("hub-onboarding-submit").click();
    await expect(page.getByTestId("hub-onboarding-step-device")).toBeVisible();
    await page.getByTestId("hub-onboarding-device-field").locator("input").fill("t34-web-host");
    await page.getByTestId("hub-onboarding-device-confirm").click();
    await expect(page.getByTestId("hub-onboarding-step-agents")).toBeVisible();
  }
  await advanceToDone(page);
}

test("onboarding done step shows the mini-program QR and copies the relay pairing link", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedT34Host(page);
  await walkOnboardingToDone(page);

  await expect(page.getByTestId("onboarding-connect-qr")).toBeVisible();
  const tile = page.getByTestId("onboarding-connect-qr-tile");
  await expect(tile).toBeVisible();
  await expect(tile.locator("svg")).toBeVisible();

  await page.getByTestId("onboarding-connect-copy").click();
  const relayUri = await page.evaluate(() => navigator.clipboard.readText());
  expect(relayUri).toMatch(/^relay:\/\/[^/?#]+:\d+\/[^?]+\?key=/);

  // The rendered QR is the encoding of the copied link — the same qrcode call
  // the app runs — so the code a phone scans decodes to exactly this URI.
  const qrPaths = await tile
    .locator("svg path")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
  const expectedSvg = await QRCode.toString(relayUri, QR_OPTIONS);
  const expectedPaths = [...expectedSvg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  expect(qrPaths).toEqual(expectedPaths);

  mkdirSync(dirname(RELAY_URI_OUT), { recursive: true });
  writeFileSync(RELAY_URI_OUT, relayUri, "utf8");
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/t34-onboarding-done-light.png`, fullPage: true });
  console.log(`[t34] relay URI captured: ${relayUri}`);
});

test("onboarding done step renders the QR in dark mode", async ({ page }) => {
  // Theme from the first load: reloading re-seeds the harness worker host,
  // which can win the earliest-online race and steal the onboarding screen.
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "dark" }));
  });
  await seedT34Host(page);
  await walkOnboardingToDone(page);
  await expect(page.getByTestId("onboarding-connect-qr")).toBeVisible();

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/t34-onboarding-done-dark.png`, fullPage: true });
});

test("host settings page leads with the Connect phone tile", async ({ page }) => {
  await seedT34Host(page);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, SERVER_ID);
  await openSettingsHostSection(page, SERVER_ID, "host");

  const tile = page.getByTestId("host-page-connect-phone-tile");
  await expect(tile).toBeVisible();

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({
    path: `${SHOT_DIR}/t34-settings-connect-phone-tile.png`,
    fullPage: true,
  });

  await tile.click();
  await expect(page.getByTestId("host-page-connect-phone-card")).toBeVisible();
  await expect(page.getByTestId("pair-device-content")).toBeVisible();

  await page.screenshot({
    path: `${SHOT_DIR}/t34-settings-pair-device-sheet.png`,
    fullPage: true,
  });
});
