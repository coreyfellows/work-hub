import { createContext } from 'react';

/** The conversation view drawing its children: Chat (`readable`) or the raw Log. */
export interface LogView {
  sessionId: string;
  readable: boolean;
}

/** Set by the conversation view around its log (null elsewhere), so Markdown overrides and cards can tell Chat from Log. */
export const LogViewContext = createContext<LogView | null>(null);
