import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard.tsx";
import type { AgetorClient, CoreInfo } from "../api-client.ts";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// Smoke test: the whole tree mounts (header, empty board, footer hints, and the
// SSE hooks) without throwing. dataDir points nowhere so discoverCore returns
// null and the streams just back off harmlessly; unmount() tears them down.
test("Dashboard mounts the header, empty state, and the new key hints", async () => {
  const client = { listTasks: async () => [] } as unknown as AgetorClient;
  const core = {
    kind: "cli-daemon",
    port: 4317,
    token: "x",
    version: "0.0.0",
    pid: 1,
    startedAt: 0,
  } as unknown as CoreInfo;

  const { lastFrame, unmount } = render(
    <Dashboard client={client} core={core} dataDir="/nonexistent-agetor-test" />,
  );
  await wait();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Agetor");
  expect(frame).toContain("no tasks");
  expect(frame).toContain("m message");
  expect(frame).toContain("g answer");
  unmount();
});
