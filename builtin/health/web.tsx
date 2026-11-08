import { SourceBlock, StatusRow, type Issue, type Sources, type WebPluginContext } from '../../plugin-api/web.ts';
import type { HealthData } from './types.ts';

export type { HealthCheck, HealthData, McpServer } from './types.ts';

const healthOf = (sources: Sources) => sources.health?.data as HealthData | null | undefined;

/** Failed checks (other than 'info') and watched MCP servers that aren't connected, for the dot and the Status page. */
export function healthIssues(sources: Sources): Issue[] {
  const issues: Issue[] = [];
  const health = healthOf(sources);
  for (const c of health?.checks ?? []) {
    if (!c.ok && c.level !== 'info') issues.push({ level: c.level, title: c.label, detail: c.detail });
  }
  for (const m of health?.mcp ?? []) {
    if (m.watched && m.state !== 'connected') {
      issues.push({ level: 'fire', title: `MCP server ${m.name}: ${m.state}`, detail: m.detail || 'run /mcp in Claude Code to reconnect' });
    }
  }
  return issues;
}

function MachineBlock({ sources }: { sources: Sources }) {
  const health = healthOf(sources);
  return (
    <SourceBlock title="This machine" state={sources.health}>
      {health?.checks.map((c) => (
        <StatusRow key={c.id} ok={c.ok} label={c.label} detail={c.detail} />
      ))}
      {health?.mcp.map((m) => (
        <StatusRow
          key={m.name}
          ok={m.state === 'connected'}
          label={`MCP ${m.name}`}
          detail={`${m.state}${m.detail && m.state !== 'connected' ? ` · ${m.detail}` : ''}`}
          dim={!m.watched}
        />
      ))}
    </SourceBlock>
  );
}

export default function register(ctx: WebPluginContext): void {
  // Order 0: these come before other plugins' issue items (e.g. github's changes requested, 110).
  ctx.contribute('health-issues', { order: 0, collect: healthIssues });
  ctx.contribute('status-block', { id: 'machine', title: 'This machine', order: 20, component: MachineBlock });
}
