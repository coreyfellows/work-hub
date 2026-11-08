import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { userInfo } from 'node:os';

/**
 * The few things that differ between macOS, Linux and Windows, in one place: keyboard/mouse idle time (the registry
 * only polls while the machine is in use), how to start the pty bridge (ptybridge.py), the default shell for new
 * terminals, the terminal daemon's socket, and path containment that doesn't assume `/`. Node builtins only, so the
 * standalone terminal daemon can use it too (through plugin-api/platform.ts).
 */

export type Platform = 'darwin' | 'linux' | 'win32';

/** The platform this runs on; `WORK_HUB_PLATFORM` overrides it (tests). Anything that isn't macOS or Windows is treated as Linux. */
export function platform(env: NodeJS.ProcessEnv = process.env): Platform {
  const p = env.WORK_HUB_PLATFORM || process.platform;
  return p === 'darwin' || p === 'win32' ? p : 'linux';
}

export const isWindows = (env: NodeJS.ProcessEnv = process.env): boolean => platform(env) === 'win32';

// ---------------------------------------------------------------------------------------------------------------------
// Idle time

type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

/** macOS: IOHIDSystem's HIDIdleTime (nanoseconds). */
export function parseIoregIdle(out: string): number | null {
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Math.floor(Number(m[1]) / 1e9) : null;
}

/** GNOME's `org.gnome.Mutter.IdleMonitor.GetIdletime` over gdbus prints `(uint64 12345,)` (milliseconds). */
export function parseGdbusIdle(out: string): number | null {
  const m = out.match(/\(uint64\s+(\d+),?\)/);
  return m ? Math.floor(Number(m[1]) / 1000) : null;
}

/** `loginctl show-session <id> -p IdleHint -p IdleSinceHint`: idle only when IdleHint=yes (IdleSinceHint is µs since the epoch). */
export function parseLoginctlIdle(out: string, nowMs: number): number | null {
  const hint = /^IdleHint=(\w+)/m.exec(out)?.[1];
  if (hint === 'no') return 0;
  const since = Number(/^IdleSinceHint=(\d+)/m.exec(out)?.[1]);
  if (hint !== 'yes' || !since) return null;
  return Math.max(0, Math.floor((nowMs - since / 1000) / 1000));
}

/**
 * Linux, first that answers: `xprintidle` (X11, ms), GNOME's Mutter IdleMonitor (Wayland or X11), then logind's
 * idle hint (set by most desktops and screen lockers). A headless box answers none of them: null, and the registry
 * then works while someone is watching, as it does when idle time can't be read anywhere.
 */
async function linuxIdleSeconds(runner: Runner, env: NodeJS.ProcessEnv): Promise<number | null> {
  const opts = { timeoutMs: 3_000 };
  if (env.DISPLAY) {
    try {
      const ms = Number((await runner('xprintidle', [], opts)).trim());
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    } catch {
      /* not installed or no X server */
    }
  }
  try {
    const out = await runner('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core', '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'], opts);
    const s = parseGdbusIdle(out);
    if (s !== null) return s;
  } catch {
    /* not GNOME, or no session bus */
  }
  try {
    const out = await runner('loginctl', ['show-session', env.XDG_SESSION_ID || 'auto', '-p', 'IdleHint', '-p', 'IdleSinceHint'], opts);
    return parseLoginctlIdle(out, Date.now());
  } catch {
    return null;
  }
}

/**
 * Windows: one hidden PowerShell, started on first use, prints GetLastInputInfo's idle milliseconds every few seconds;
 * we keep the latest line. Starting PowerShell (and compiling the P/Invoke) takes a second or two, too slow per tick.
 */
const WINDOWS_IDLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WorkHubIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint Ms() {
    var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return 0;
    return unchecked((uint)Environment.TickCount - i.dwTime);
  }
}
'@
while ($true) { [Console]::Out.WriteLine([WorkHubIdle]::Ms()); [Console]::Out.Flush(); Start-Sleep -Seconds 5 }
`;

let winIdle: { child: ChildProcess | null; seconds: number | null; at: number } | null = null;

function windowsIdleSeconds(): number | null {
  if (!winIdle) {
    winIdle = { child: null, seconds: null, at: 0 };
    const state = winIdle;
    const encoded = Buffer.from(WINDOWS_IDLE_SCRIPT, 'utf16le').toString('base64');
    try {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      state.child = child;
      let buf = '';
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        const last = lines.filter((l) => /^\d+$/.test(l.trim())).pop();
        if (last) {
          state.seconds = Math.floor(Number(last.trim()) / 1000);
          state.at = Date.now();
        }
      });
      // If it dies, forget it: the next call starts another (at most one at a time).
      child.on('exit', () => {
        if (winIdle === state) winIdle = null;
      });
      child.on('error', () => {
        if (winIdle === state) winIdle = null;
      });
      child.unref();
      process.once('exit', () => child.kill());
    } catch {
      winIdle = null;
      return null;
    }
  }
  // A reading older than 30s means the helper is stuck: unknown.
  return winIdle && Date.now() - winIdle.at < 30_000 ? winIdle.seconds : null;
}

/** Seconds since the last keyboard/mouse input on this machine, or null if it can't be read. */
export async function idleSeconds(runner: Runner, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  switch (platform(env)) {
    case 'darwin':
      try {
        return parseIoregIdle(await runner('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { timeoutMs: 3_000 }));
      } catch {
        return null;
      }
    case 'win32':
      return windowsIdleSeconds();
    default:
      return linuxIdleSeconds(runner, env);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The pty bridge

/** The Python that runs ptybridge.py: `WORK_HUB_PYTHON`, else `python3` (`python` on Windows, where the python.org installer and the Store both provide it). */
export function pythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORK_HUB_PYTHON || (isWindows(env) ? 'python' : 'python3');
}

/** `spawn(cmd, args)` for running `argv` inside a pty of the given size through the bridge at `bridge`. */
export function ptyBridgeCommand(bridge: string, cols: number, rows: number, argv: string[], env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  return { cmd: pythonCommand(env), args: ['-u', bridge, String(cols), String(rows), ...argv] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Terminals

/** Is `p` an executable file (on Windows: an existing file, as Windows has no execute bit)? */
export function isExecutableFile(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWindows(env)) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first of `names` found on PATH (with PATHEXT on Windows), as an absolute path. */
export function findOnPath(names: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(isWindows(env) ? ';' : delimiter).filter(Boolean);
  const exts = isWindows(env) ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const name of names) for (const dir of dirs) for (const ext of exts) {
    const p = join(dir, name + ext);
    if (existsSync(p) && isExecutableFile(p, env)) return p;
  }
  return null;
}

/**
 * The shell new terminals run when nothing else is set: your login shell with `-l` on macOS and Linux (`/bin/sh` if
 * there's none); on Windows PowerShell 7 (`pwsh.exe`) if it's installed, else Windows PowerShell, with `-NoLogo`.
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): { shell: string; args: string[] } {
  if (isWindows(env)) {
    const shell = findOnPath(['pwsh'], env) ?? (env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe');
    return { shell, args: ['-NoLogo'] };
  }
  let login: string | null = null;
  try {
    login = userInfo().shell;
  } catch {
    /* no passwd entry */
  }
  return { shell: env.SHELL || login || '/bin/sh', args: ['-l'] };
}

/**
 * Windows: Git for Windows' bash (what Claude Code's Bash tool runs, and what `!` commands and bin/ scripts need):
 * `CLAUDE_CODE_GIT_BASH_PATH` (Claude Code's own setting), else beside `git` on PATH (`…\Git\cmd\git.exe` →
 * `…\Git\bin\bash.exe`), else under Program Files. Never `System32\bash.exe`, which is WSL's.
 */
export function gitBashPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  const git = findOnPath(['git'], env);
  if (git) candidates.push(join(git, '..', '..', 'bin', 'bash.exe'));
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Where the terminal daemon listens unless configured: `<state>/termd.sock`, or on Windows a per-user named pipe. */
export function defaultTermdSocket(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isWindows(env)) return join(stateDir, 'termd.sock');
  const user = (env.USERNAME || 'user').replace(/[^A-Za-z0-9-]/g, '-');
  return `\\\\.\\pipe\\work-hub-termd-${user}`;
}

/** Is this a Windows named pipe path (`\\.\pipe\…`)? Those aren't files: no unlink, no chmod. */
export const isNamedPipe = (p: string): boolean => /^\\\\[.?]\\pipe\\/i.test(p);

// ---------------------------------------------------------------------------------------------------------------------
// Keeping the machine awake

/**
 * A command that keeps the machine from idle-sleeping until process `pid` exits (or the command is killed), while the
 * display may still sleep and closing the lid still suspends:
 * - macOS: `caffeinate -i -w <pid>`;
 * - Linux: `systemd-inhibit --what=idle:sleep` around `tail --pid=<pid> -f /dev/null` (logind ignores inhibitors for the
 *   lid switch by default, so the lid still suspends);
 * - Windows: a hidden PowerShell holding `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` until the process
 *   exits (no ES_DISPLAY_REQUIRED, so the screen still turns off).
 */
export function keepAwakeCommand(pid: number, env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  switch (platform(env)) {
    case 'darwin':
      return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
    case 'win32': {
      const script = [
        "Add-Type -Name Power -Namespace WorkHub -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
        '[void][WorkHub.Power]::SetThreadExecutionState(0x80000001)',
        `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      ].join('; ');
      return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
    }
    default:
      return { cmd: 'systemd-inhibit', args: ['--what=idle:sleep', '--who=work-hub', '--why=A Claude session is working', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'] };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

/**
 * One spelling for a path, so paths from different tools compare equal: as is on macOS and Linux; on Windows forward
 * slashes, an upper-case drive letter, and Git Bash's `/c/Users/…` as `C:/Users/…` (Claude reports `C:\Users\…`, git
 * prints `C:/Users/…`). Code that checks containment with `/` works on the result.
 */
export function normPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isWindows(env) || !p) return p;
  let s = p.replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  s = s.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
  return s.length > 3 ? s.replace(/\/+$/, '') : s;
}
