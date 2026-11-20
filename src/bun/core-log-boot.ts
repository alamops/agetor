// Side-effect import, first in `index.ts`: from here on every console line of
// the desktop core is also written to `core.log` (see `core-log.ts`).
import { installCoreLog } from "./core-log.ts";

installCoreLog();
