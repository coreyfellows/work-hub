/** The models a session can be started on (New session, Hand off), strongest first. Shared by plugin-api/server.ts and web.ts. */
export const SESSION_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type SessionModel = (typeof SESSION_MODELS)[number];
