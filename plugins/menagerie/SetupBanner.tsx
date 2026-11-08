import { useState } from 'react';
import { Link, usePath } from '../../plugin-api/web.ts';
import { CastStyle } from './CastStyle.tsx';
import { useCastJobWatcher, useGenJobs } from './castJobs.ts';
import { useFunHosts, useHostsLoaded } from './menagerie.ts';

export const SETUP_PATH = '/settings/plugins/menagerie';
const DISMISS_KEY = 'wh.menagerieSetupDismissed';

const dismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Mounted on every page (`app-banner`): the cast's animation stylesheet, the job watcher that reloads the cast, and,
 * while the plugin is on but there's no cast yet, a dismissable prompt to set one up.
 */
export function SetupBanner() {
  useCastJobWatcher();
  const hosts = useFunHosts();
  const loaded = useHostsLoaded();
  const running = useGenJobs().some((j) => j.status === 'running');
  const path = usePath();
  const [hidden, setHidden] = useState(dismissed);
  const show = loaded && !hosts.length && !running && !hidden && path !== SETUP_PATH;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: hide for this page only */
    }
    setHidden(true);
  };
  return (
    <>
      <CastStyle />
      {show && (
        <div className="fun-setup-offer">
          <span className="grow">Menagerie is on: pick the characters you'd like as hosts.</span>
          <Link to={SETUP_PATH} className="button primary">
            Set up
          </Link>
          <button className="icon ghost" aria-label="Dismiss" onClick={dismiss}>
            ✕
          </button>
        </div>
      )}
    </>
  );
}
