import { render } from "ink";
import { Dashboard } from "./Dashboard.tsx";
import type { AgetorClient, CoreInfo } from "../api-client.ts";

/** Mount the full-screen dashboard and resolve when the user quits. */
export async function runDashboard(
  client: AgetorClient,
  core: CoreInfo,
  dataDir?: string,
): Promise<void> {
  const app = render(<Dashboard client={client} core={core} dataDir={dataDir} />);
  await app.waitUntilExit();
}
