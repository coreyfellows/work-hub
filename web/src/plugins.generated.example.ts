// The shape of web/src/plugins.generated.ts (gitignored; written by server/plugins/generateWebModule.ts on every
// `pnpm dev`/`pnpm build`, and by `scripts/gen-plugins.ts` before typecheck and tests). One import per active plugin
// with a `web` entry, its styles.css if it has one, then its register call; the core's layout overrides last.
// Official plugins are imported relative to this folder, local ones (plugins.json `local`) by absolute path.
//
// import { createWebContext } from './pluginContext.ts';
// import p0 from '../../plugins/github/web.tsx';
// import '../../plugins/github/styles.css';
// p0(createWebContext('github'));
// import p1 from '/Users/me/my-plugins/standup/web.tsx';
// p1(createWebContext('standup'));
// import './layout-overrides.css';
export {};
