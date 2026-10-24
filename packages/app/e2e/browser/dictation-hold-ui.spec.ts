import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";

type WebSocketMessage = string | Buffer;

const FINAL_TRANSCRIPT = "帮我创建一个新的功能分支";
const PARTIAL_TRANSCRIPTS = ["帮我创建", FINAL_TRANSCRIPT];
const SCREENSHOT_DIR = "/tmp/t32a-shots";

function parseEnvelope(message: WebSocketMessage): {
  type?: unknown;
  message?: Record<string, unknown>;
} | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw) as { type?: unknown; message?: Record<string, unknown> };
  } catch {
    return null;
  }
}

function sessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseEnvelope(message);
  return envelope?.type === "session" && envelope.message ? envelope.message : null;
}

function sendSessionMessage(
  ws: { send(message: string): void },
  message: Record<string, unknown>,
): void {
  ws.send(JSON.stringify({ type: "session", message }));
}

function enableDictationCapability(message: WebSocketMessage): WebSocketMessage {
  const envelope = parseEnvelope(message);
  const payload = envelope?.message?.payload;
  if (
    envelope?.message?.type !== "status" ||
    !payload ||
    typeof payload !== "object" ||
    (payload as { status?: unknown }).status !== "server_info"
  ) {
    return message;
  }

  (payload as Record<string, unknown>).capabilities = {
    voice: {
      dictation: { enabled: true, reason: "" },
      voice: { enabled: false, reason: "Realtime voice is disabled in this test." },
    },
  };
  return JSON.stringify(envelope);
}

async function installSyntheticMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  });
}

function installDictationHoldHarness(page: Page): {
  waitForFirstChunk: () => Promise<void>;
} {
  let chunkCount = 0;
  let resolveFirstChunk!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    resolveFirstChunk = resolve;
  });

  void page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = sessionMessage(message);
      const type = request?.type;
      const dictationId = typeof request?.dictationId === "string" ? request.dictationId : null;

      if (type === "dictation_stream_start" && dictationId) {
        chunkCount = 0;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: -1 },
        });
        return;
      }
      if (type === "dictation_stream_chunk" && dictationId) {
        const seq = typeof request?.seq === "number" ? request.seq : 0;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: seq },
        });
        const partial = PARTIAL_TRANSCRIPTS[Math.min(chunkCount, PARTIAL_TRANSCRIPTS.length - 1)];
        chunkCount += 1;
        sendSessionMessage(ws, {
          type: "dictation_stream_partial",
          payload: { dictationId, text: partial },
        });
        resolveFirstChunk();
        return;
      }
      if (type === "dictation_stream_finish" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_finish_accepted",
          payload: { dictationId, timeoutMs: 5_000 },
        });
        sendSessionMessage(ws, {
          type: "dictation_stream_final",
          payload: { dictationId, text: FINAL_TRANSCRIPT },
        });
        return;
      }

      server.send(message);
    });

    server.onMessage((message) => ws.send(enableDictationCapability(message)));
  });

  return { waitForFirstChunk: () => firstChunk };
}

test.describe("Dictation hold-to-talk UI", () => {
  test.describe.configure({ timeout: 240_000 });

  test("hold mic shows overlay with live partial text and release inserts the transcript", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-hold-",
      title: "Dictation hold UI",
    });
    await installSyntheticMicrophone(page);
    const harness = installDictationHoldHarness(page);

    try {
      await gotoAppShell(page);
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      const micButton = page.getByRole("button", { name: "Start dictation", exact: true });
      await expect(micButton).toBeVisible();

      // Idle composer, light theme.
      await page.screenshot({ path: `${SCREENSHOT_DIR}/idle-light.png` });

      // Press and hold: overlay with partial transcript, waveform, and hint.
      await micButton.click({ trial: true });
      const micBox = await micButton.boundingBox();
      expect(micBox).not.toBeNull();
      const micCenter = { x: micBox!.x + micBox!.width / 2, y: micBox!.y + micBox!.height / 2 };
      await page.mouse.move(micCenter.x, micCenter.y);
      await page.mouse.down();
      await expect(
        page.getByRole("button", { name: "Cancel dictation", exact: true }),
      ).toBeVisible();
      await harness.waitForFirstChunk();
      await expect(page.getByText("帮我创建", { exact: false })).toBeVisible();
      await expect(page.getByText("Release to insert, slide up to cancel")).toBeVisible();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/recording-light.png` });

      // Release: final transcript lands in the composer.
      await page.mouse.up();
      const composer = composerLocator(page);
      await expect(composer).toHaveValue(FINAL_TRANSCRIPT, { timeout: 15_000 });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/inserted-light.png` });
    } finally {
      await agent.cleanup();
    }
  });

  test("slide up while holding arms cancel and release discards the transcript", async ({
    page,
  }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "dictation-hold-",
      title: "Dictation hold cancel",
    });
    await installSyntheticMicrophone(page);
    installDictationHoldHarness(page);

    try {
      await page.emulateMedia({ colorScheme: "dark" });
      await gotoAppShell(page);
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      const micButton = page.getByRole("button", { name: "Start dictation", exact: true });
      await expect(micButton).toBeVisible();

      const micBox = await micButton.boundingBox();
      expect(micBox).not.toBeNull();
      const micCenter = { x: micBox!.x + micBox!.width / 2, y: micBox!.y + micBox!.height / 2 };
      await page.mouse.move(micCenter.x, micCenter.y);
      await page.mouse.down();
      await expect(
        page.getByRole("button", { name: "Cancel dictation", exact: true }),
      ).toBeVisible();
      await page.mouse.move(micCenter.x, micCenter.y - 100, { steps: 8 });
      await expect(page.getByText("Release to cancel")).toBeVisible();
      await page.screenshot({ path: `${SCREENSHOT_DIR}/cancel-armed-dark.png` });
      await page.mouse.up();
      const composer = composerLocator(page);
      await expect(composer).toHaveValue("", { timeout: 15_000 });
      await expect(composer).toBeEditable();
    } finally {
      await agent.cleanup();
    }
  });
});
