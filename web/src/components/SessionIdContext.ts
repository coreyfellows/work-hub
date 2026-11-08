import { createContext } from 'react';

/** The session whose log is showing (SessionView provides it), so cards inside it can call that session's routes. */
export const SessionIdContext = createContext<string | null>(null);
