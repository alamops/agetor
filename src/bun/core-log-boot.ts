// Side-effect import, second in `index.ts` (right after the data dir is
// settled): from here on every console line of the desktop core is also
// queued for `<dataDir>/logs/core.log` (see `core-log.ts`). Idempotent, so the
// later `installCoreLog()` in `index.ts` is a no-op; the tokens registered
// there still redact lines queued before them (the literal pass re-runs at
// flush when a secret arrives after a line was queued).
import { installCoreLog } from "./core-log.ts";

installCoreLog();
