/**
 * Platform helpers for plugins (macOS, Linux, Windows): the pty bridge command, default shell, terminal daemon socket,
 * executable and path checks. Node builtins only, so standalone helper processes (the terminals daemon) may import it.
 */
export {
  defaultShell,
  defaultTermdSocket,
  findOnPath,
  gitBashPath,
  isExecutableFile,
  isNamedPipe,
  isWindows,
  keepAwakeCommand,
  normPath,
  platform,
  ptyBridgeCommand,
  pythonCommand,
  type Platform,
} from '../server/lib/platform.ts';
