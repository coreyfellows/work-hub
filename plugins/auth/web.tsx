import { SourceBlock, StatusRow, type Issue, type Sources, type WebPluginContext } from '../../plugin-api/web.ts';
import { PairDevice, PasskeyOffer, PasskeysSetting, SignOut } from './settings.tsx';
import type { AuthStatus } from './types.ts';

export type { AuthStatus } from './types.ts';

const statusOf = (sources: Sources) => sources.auth?.data as AuthStatus | null | undefined;

/** Days of certificate left below which the Status page warns (setup-lan.sh renews it when under 30). */
const CERT_WARN_DAYS = 14;

function certDetail(s: AuthStatus): string {
  if (s.certDays === null) return `can't read ${s.certFile}${s.certError ? `: ${s.certError}` : ''}`;
  if (s.certDays > CERT_WARN_DAYS) return `valid for ${s.certDays} more days`;
  return `expires in ${s.certDays} days: re-run scripts/setup-lan.sh --apply`;
}

/** The hostname's HTTPS certificate is missing or about to expire (a warning: listed on the Status page). */
export function certIssues(sources: Sources): Issue[] {
  const s = statusOf(sources);
  if (!s?.hostname) return [];
  if (s.certDays !== null && s.certDays > CERT_WARN_DAYS) return [];
  return [{ level: 'warn', title: `HTTPS certificate (${s.hostname})`, detail: certDetail(s) }];
}

function SignInBlock({ sources }: { sources: Sources }) {
  const s = statusOf(sources);
  return (
    <SourceBlock title="Sign-in" state={sources.auth}>
      {s && (
        <>
          <StatusRow ok={!!s.hostname} label="Hostname" detail={s.hostname ?? 'none set: passkeys need WORK_HUB_HOSTNAME'} />
          {s.hostname && <StatusRow ok={s.certDays !== null && s.certDays > CERT_WARN_DAYS} label="HTTPS certificate" detail={certDetail(s)} />}
        </>
      )}
    </SourceBlock>
  );
}

export default function register(ctx: WebPluginContext): void {
  ctx.contribute('settings-section', { id: 'passkeys', title: 'Passkeys', order: 10, component: PasskeysSetting });
  ctx.contribute('settings-section', { id: 'devices', title: 'Other devices', order: 50, component: PairDevice });
  ctx.contribute('settings-section', { id: 'sign-out', title: '', order: 1000, scope: 'app', component: SignOut });
  ctx.contribute('app-banner', { id: 'passkey-offer', component: PasskeyOffer });
  ctx.contribute('health-issues', { collect: certIssues });
  ctx.contribute('status-block', { id: 'sign-in', title: 'Sign-in', order: 25, component: SignInBlock });
}
