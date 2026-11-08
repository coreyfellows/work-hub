/** The `health` source's data, shared by the plugin's server and web halves (type-only on the web side). */

export interface HealthCheck {
  id: string;
  label: string;
  ok: boolean;
  /** How much a failure matters: 'fire' turns the connection dot red, 'warn' shows on the Status page, 'info' is listed only. */
  level: 'fire' | 'warn' | 'info';
  detail: string;
}

export interface McpServer {
  name: string;
  state: 'connected' | 'needs-auth' | 'failed' | 'unknown';
  detail: string;
  /** In the watched list: a watched server that isn't connected turns the dot red. */
  watched: boolean;
}

export interface HealthData {
  checks: HealthCheck[];
  mcp: McpServer[];
}
