/** This session's host (a cast id), or null before one moved in. */
export type HostId = string | null

declare module 'claude-code' {
  interface PluginState {
    'work-hub-menagerie': {
      host: HostId
    }
  }
}
