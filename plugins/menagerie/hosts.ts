// GET /api/menagerie/hosts: the user's cast as the UI draws it ([] when there is none yet).
import type { CastStore } from './castStore.ts';
import { toFunHost } from './cast.ts';
import type { FunHost } from './types.ts';

export type { FunHost };

export async function menagerieHosts(store: CastStore): Promise<FunHost[]> {
  return (await store.read()).characters.map(toFunHost);
}
