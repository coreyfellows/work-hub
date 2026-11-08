/**
 * The web halves of the app's own features (builtin/<name>/web.tsx), always on: imported once at startup, before the
 * generated module that loads the active plugins. The server side is server/builtin.ts.
 */
import { createWebContext } from './pluginContext.ts';
import health from '../../builtin/health/web.tsx';
import sessionStats from '../../builtin/session-stats/web.tsx';
import '../../builtin/session-stats/styles.css';
import sessionTools from '../../builtin/session-tools/web.tsx';
import '../../builtin/session-tools/styles.css';

health(createWebContext('health'));
sessionStats(createWebContext('session-stats'));
sessionTools(createWebContext('session-tools'));
