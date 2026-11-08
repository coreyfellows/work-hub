"""Run a command inside a pseudo-terminal of a given size, relaying our stdin to it and its output to
our stdout. Lets the (non-TTY) server drive TUIs such as `claude attach <id>`.

Usage: python3 ptybridge.py <cols> <rows> <command> [args...]
If file descriptor 3 is open, lines of "<cols> <rows>" read from it resize the terminal.
Exits when the command exits or our stdin closes.

macOS and Linux use the pty module. Windows uses ConPTY through pywinpty (`python -m pip install pywinpty`),
with threads in place of select(), which doesn't work on pipes there.
"""
import os
import sys

cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]


def has_control_channel():
    # Check for the resize channel BEFORE creating the pty: otherwise fd 3 may be free here and pty.fork()
    # would hand it to the pty master, which we'd then mistake for the control channel and read from.
    try:
        os.fstat(3)
        return True
    except OSError:
        return False


def parse_resize(line):
    parts = line.split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        return max(20, min(400, int(parts[0]))), max(5, min(200, int(parts[1])))
    return None


def run_windows():
    import codecs
    import threading

    try:
        from winpty import PtyProcess
    except ImportError:
        sys.stderr.write('ptybridge: pywinpty is not installed; run: python -m pip install pywinpty\n')
        sys.exit(127)

    control = 3 if has_control_channel() else None
    env = dict(os.environ)
    env['TERM'] = 'xterm-256color'
    proc = PtyProcess.spawn(argv, dimensions=(rows, cols), env=env)
    out = sys.stdout.buffer

    def pump_stdin():
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    break
                text = decoder.decode(data)
                if text:
                    proc.write(text)
        except OSError:
            pass
        # Our stdin closed: hang up the child (a clean detach for `claude attach`), which ends the read loop below.
        try:
            proc.terminate(force=True)
        except Exception:
            pass

    def pump_control():
        buf = b''
        try:
            while True:
                data = os.read(control, 4096)
                if not data:
                    return
                buf += data
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    size = parse_resize(line)
                    if size:
                        proc.setwinsize(size[1], size[0])
        except OSError:
            return

    threading.Thread(target=pump_stdin, daemon=True).start()
    if control is not None:
        threading.Thread(target=pump_control, daemon=True).start()
    try:
        while True:
            try:
                data = proc.read(65536)
            except EOFError:
                break
            if data:
                out.write(data.encode('utf-8', errors='replace'))
                out.flush()
            elif not proc.isalive():
                break
    finally:
        try:
            if proc.isalive():
                proc.terminate(force=True)
        except Exception:
            pass
    sys.exit(0)


def run_posix():
    import fcntl
    import pty
    import select
    import signal
    import struct
    import termios

    control = 3 if has_control_channel() else None

    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp(argv[0], argv)

    def resize(c, r):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)

    resize(cols, rows)

    control_buf = b''

    stdin_open = True
    try:
        while True:
            fds = [master] + ([sys.stdin.fileno()] if stdin_open else []) + ([control] if control is not None else [])
            ready, _, _ = select.select(fds, [], [], 0.5)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if stdin_open and sys.stdin.fileno() in ready:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    stdin_open = False
                    break
                os.write(master, data)
            if control is not None and control in ready:
                data = os.read(control, 4096)
                if not data:
                    control = None
                    continue
                control_buf += data
                while b'\n' in control_buf:
                    line, control_buf = control_buf.split(b'\n', 1)
                    size = parse_resize(line)
                    if size:
                        resize(*size)
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if os.name == 'nt':
    run_windows()
else:
    run_posix()
