import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The launchd scripts only ever run here against a temp LaunchAgents dir (WORK_HUB_LAUNCH_AGENTS_DIR), a temp HOME and
// a fake `launchctl` on PATH that records its calls: never the real ~/Library/LaunchAgents or launchd. Their Linux
// backend (scripts/lib/service.sh) runs with WORK_HUB_PLATFORM=Linux against a temp WORK_HUB_SYSTEMD_USER_DIR and a fake
// `systemctl`, on any OS.
const REPO = join(import.meta.dirname, '..');
const PREFIX = 'com.launchd-test.work-hub';
const isMac = process.platform === 'darwin';
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const STUBS: Record<string, string> = {
  launchctl: `echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  list) printf 'PID\\tStatus\\tLabel\\n'; [ -f "$STUB_DIR/list" ] && cat "$STUB_DIR/list"; exit 0 ;;
  print) [ -e "$STUB_DIR/loaded-$(basename "$2")" ]; exit $? ;;
  bootstrap) touch "$STUB_DIR/loaded-$(basename "$3" .plist)" "$STUB_DIR/listening"; exit 0 ;;
  bootout) rm -f "$STUB_DIR/loaded-$(basename "$2")"; exit 0 ;;
esac
exit 0`,
  // systemctl --user <cmd> [flags] [unit]: list-units prints $STUB_DIR/units; enable --now / disable --now mark a unit
  // active or not ($STUB_DIR/active-<unit>), which is-active reports.
  systemctl: `echo "$*" >> "$STUB_DIR/sd-calls"
[ "$1" = --user ] || exit 1
shift; cmd="$1"; shift; u=""
for a in "$@"; do case "$a" in -*) ;; *) u="$a" ;; esac; done
case "$cmd" in
  list-units) [ -f "$STUB_DIR/units" ] && cat "$STUB_DIR/units"; exit 0 ;;
  is-active) [ -e "$STUB_DIR/active-$u" ]; exit $? ;;
  enable) touch "$STUB_DIR/active-$u" "$STUB_DIR/listening"; exit 0 ;;
  disable) rm -f "$STUB_DIR/active-$u"; exit 0 ;;
esac
exit 0`,
  xclip: 'cat > "$STUB_DIR/clipboard"',
  'xdg-open': 'echo "$*" >> "$STUB_DIR/xdg-open"',
  lsof: '[ -e "$STUB_DIR/listening" ]',
  pnpm: 'echo "$*" >> "$STUB_DIR/pnpm-calls"',
  pbcopy: 'cat > "$STUB_DIR/clipboard"',
  caddy: 'exit 0',
  mkcert: `while [ $# -gt 0 ]; do case "$1" in -cert-file) echo cert > "$2"; shift ;; -key-file) echo key > "$2"; shift ;; esac; shift; done`,
  silverbullet: 'exit 0',
  // setup.sh's sign-in check: signed in unless the test says otherwise ($STUB_DIR/logged-out).
  claude: `if [ "$1" = auth ]; then if [ -e "$STUB_DIR/logged-out" ]; then echo '{"loggedIn": false}'; else echo '{"loggedIn": true}'; fi; fi; exit 0`,
  'code-cli': 'exit 0',
  // update.sh pulls; nothing here may touch the real checkout's refs.
  // An upstream exists only when the test says so ($STUB_DIR/upstream).
  git: `if [ "$1" = pull ]; then echo "(stub) pull"; exit 0; fi
for a in "$@"; do if [ "$a" = '@{upstream}' ]; then [ -e "$STUB_DIR/upstream" ] || exit 128; echo origin/main; exit 0; fi; done
exec "${realGit}" "$@"`,
};

type Env = { dir: string; agents: string; stub: string; run: (script: string, args: string[], extra?: Record<string, string>) => { code: number; out: string } };

function withEnv(fn: (e: Env) => void, platform: 'Darwin' | 'Linux' = 'Darwin'): void {
  const dir = mkdtempSync(join(tmpdir(), 'wh-launchd-'));
  const agents = join(dir, 'agents');
  const stub = join(dir, 'stub');
  const bin = join(dir, 'bin');
  for (const d of [agents, stub, bin, join(dir, 'home'), join(dir, 'config'), join(dir, 'state')]) mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, 'config', 'plugins.json'), JSON.stringify({
    enabled: { auth: true, terminals: true, notes: false, code: false },
    settings: { terminals: { autostart: false } },
  }));
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('WORK_HUB_') && !k.startsWith('TW_')) base[k] = v;
  // Linux: units in <dir>/agents, logs under a temp XDG_STATE_HOME, and xclip (the stub) as the clipboard.
  const linux: Record<string, string> = platform === 'Linux'
    ? { WORK_HUB_PLATFORM: 'Linux', WORK_HUB_SYSTEMD_USER_DIR: agents, XDG_STATE_HOME: join(dir, 'xdg-state'), XDG_CONFIG_HOME: join(dir, 'xdg-config') }
    : {};
  delete base.WAYLAND_DISPLAY;
  delete base.XDG_STATE_HOME;
  delete base.XDG_CONFIG_HOME;
  const env = {
    ...base,
    HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH}`,
    STUB_DIR: stub,
    WORK_HUB_LAUNCH_AGENTS_DIR: agents,
    WORK_HUB_LAUNCHD_PREFIX: PREFIX,
    WORK_HUB_STATE_DIR: join(dir, 'state'),
    WORK_HUB_CONFIG_DIR: join(dir, 'config'),
    WORK_HUB_CACHE_DIR: join(dir, 'cache'),
    WORK_HUB_CADDY: join(bin, 'caddy'),
    WORK_HUB_MKCERT: join(bin, 'mkcert'),
    WORK_HUB_PORT: '47001',
    WORK_HUB_PUBLIC_PORT: '47002',
    ...linux,
  };
  try {
    fn({
      dir, agents, stub,
      run: (script, args, extra = {}) => {
        const r = spawnSync(join(REPO, script), args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
        return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A plist like the scripts write: `repo` goes in WORK_HUB_REPO (or, with `legacy`, only in WorkingDirectory). */
function stubPlist(agents: string, label: string, repo: string, legacy = false): string {
  const env = legacy ? '' : `<key>EnvironmentVariables</key><dict><key>WORK_HUB_REPO</key><string>${repo}</string></dict>`;
  const file = join(agents, `${label}.plist`);
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${repo}</string>
<key>ProgramArguments</key><array><string>/usr/bin/true</string></array>${env}</dict></plist>
`);
  return readFileSync(file, 'utf8');
}

const calls = (stub: string) => (existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8') : '');
const plistValue = (file: string, key: string) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).replace(/\n$/, '');
const FOREIGN = '/tmp/some-other-work-hub-checkout';
const LAN = ['scripts/setup-lan.sh', ['--hostname', 'wh.test', '--apply']] as const;

test('setup-lan --apply refuses when a managed plist points at another checkout, and touches nothing', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    const before = stubPlist(agents, PREFIX, FOREIGN);
    const r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`Refusing to touch ${PREFIX}: .*points at ${FOREIGN}`));
    assert.equal(calls(stub), '');
    assert.equal(readFileSync(join(agents, `${PREFIX}.plist`), 'utf8'), before);
  });
});

test('setup-lan dry run only warns about a foreign plist', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, `${PREFIX}-tls`, FOREIGN);
    const r = run('scripts/setup-lan.sh', ['--hostname', 'wh.test']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`warning: --apply would refuse ${PREFIX}-tls`));
    assert.equal(calls(stub), '');
  });
});

test('setup-lan --apply replaces its own agents, stamps them, and leaves -term and unmanaged labels alone', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, REPO);
    stubPlist(agents, `${PREFIX}-tls`, REPO, true); // an older plist of this checkout: WorkingDirectory only
    const term = stubPlist(agents, `${PREFIX}-term`, REPO);
    const notes = stubPlist(agents, `${PREFIX}-notes`, FOREIGN); // notes is off: not managed, not checked, not removed
    const r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 0, r.out);
    const c = calls(stub);
    assert.match(c, new RegExp(`bootstrap gui/\\d+ ${agents}/${PREFIX}\\.plist`));
    assert.match(c, new RegExp(`bootstrap gui/\\d+ ${agents}/${PREFIX}-tls\\.plist`));
    assert.doesNotMatch(c, /-term|-notes/);
    assert.equal(readFileSync(join(agents, `${PREFIX}-term.plist`), 'utf8'), term);
    assert.equal(readFileSync(join(agents, `${PREFIX}-notes.plist`), 'utf8'), notes);
    assert.match(r.out, /-term is installed and left alone \(pass --with-term/);
    const server = join(agents, `${PREFIX}.plist`);
    assert.equal(plistValue(server, 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
    assert.equal(plistValue(server, 'ProgramArguments.1'), join(REPO, 'server/index.ts'));
    assert.equal(plistValue(join(agents, `${PREFIX}-tls.plist`), 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
  });
});

test('setup-lan with auth off: dry run says it would turn it on and changes nothing; --apply turns it on, keeps the rest and copies the link', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ dir, stub, run }) => {
    const file = join(dir, 'config', 'plugins.json');
    writeFileSync(file, JSON.stringify({ enabled: { auth: false, notes: false }, settings: { slack: { user: 'U1' } } }));
    const before = readFileSync(file, 'utf8');
    let r = run('scripts/setup-lan.sh', ['--hostname', 'wh.test']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /would turn on the auth plugin/);
    assert.match(r.out, /would then copy the sign-in link for https:\/\/wh\.test:47002/);
    assert.equal(readFileSync(file, 'utf8'), before);
    r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Turned on the auth plugin/);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(cfg, { enabled: { auth: true, notes: false }, settings: { slack: { user: 'U1' } } });
    const link = readFileSync(join(stub, 'clipboard'), 'utf8');
    assert.match(link, /^https:\/\/wh\.test:47002\/login#t=[A-Za-z0-9_-]{20,}$/);
    assert.ok(!r.out.includes(link.split('#t=')[1]!), 'the token is never printed');
  });
});

test('setup-lan --apply with no plugins.json creates it with auth on; --no-link copies nothing', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ dir, stub, run }) => {
    const file = join(dir, 'config', 'plugins.json');
    rmSync(file);
    const r = run(LAN[0], [...LAN[1], '--no-link']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: { auth: true } });
    assert.ok(!existsSync(join(stub, 'clipboard')));
    assert.match(r.out, /setup-auth\.sh --apply --hostname wh\.test copies the first sign-in link/);
  });
});

test('setup-lan refusing a foreign plist leaves auth off', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ dir, agents, run }) => {
    const file = join(dir, 'config', 'plugins.json');
    writeFileSync(file, JSON.stringify({ enabled: { auth: false } }));
    stubPlist(agents, PREFIX, FOREIGN);
    const r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 1, r.out);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).enabled.auth, false);
  });
});

test('setup-lan --apply --with-term manages -term too', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, `${PREFIX}-term`, REPO);
    const r = run(LAN[0], [...LAN[1], '--with-term']);
    assert.equal(r.code, 0, r.out);
    assert.match(calls(stub), new RegExp(`bootstrap gui/\\d+ ${agents}/${PREFIX}-term\\.plist`));
    assert.equal(plistValue(join(agents, `${PREFIX}-term.plist`), 'ProgramArguments.1'), join(REPO, 'plugins/terminals/termd.ts'));
  });
});

test('setup-lan --adopt takes over a foreign plist', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, FOREIGN);
    const r = run(LAN[0], [...LAN[1], '--adopt']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Adopting ${PREFIX} \\(--adopt\\)`));
    assert.match(calls(stub), new RegExp(`bootout gui/\\d+/${PREFIX}\\n`));
    assert.equal(plistValue(join(agents, `${PREFIX}.plist`), 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
  });
});

test('setup-lan --uninstall removes its own agents, keeps -term without --with-term, refuses foreign ones', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, REPO);
    stubPlist(agents, `${PREFIX}-tls`, REPO);
    stubPlist(agents, `${PREFIX}-term`, REPO);
    let r = run('scripts/setup-lan.sh', ['--uninstall']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(agents, `${PREFIX}.plist`)));
    assert.ok(!existsSync(join(agents, `${PREFIX}-tls.plist`)));
    assert.ok(existsSync(join(agents, `${PREFIX}-term.plist`)));
    assert.doesNotMatch(calls(stub), /-term/);
    r = run('scripts/setup-lan.sh', ['--uninstall', '--with-term']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(agents, `${PREFIX}-term.plist`)));

    stubPlist(agents, PREFIX, REPO);
    stubPlist(agents, `${PREFIX}-code`, FOREIGN);
    r = run('scripts/setup-lan.sh', ['--uninstall']);
    assert.equal(r.code, 1, r.out);
    assert.ok(existsSync(join(agents, `${PREFIX}.plist`)), 'nothing removed when any label is refused');
    assert.ok(existsSync(join(agents, `${PREFIX}-code.plist`)));
  });
});

test('update.sh restarts only agents whose plist points at this checkout, never -term', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, REPO);
    stubPlist(agents, `${PREFIX}-tls`, FOREIGN);
    stubPlist(agents, `${PREFIX}-term`, REPO);
    writeFileSync(join(stub, 'list'), [PREFIX, `${PREFIX}-tls`, `${PREFIX}-term`, `${PREFIX}-gone`, 'com.other.thing'].map((l) => `-\t0\t${l}`).join('\n') + '\n');
    const r = run('scripts/update.sh', []);
    assert.equal(r.code, 0, r.out);
    const kicks = calls(stub).split('\n').filter((l) => l.startsWith('kickstart'));
    assert.equal(kicks.length, 1, r.out);
    assert.match(kicks[0]!, new RegExp(`gui/\\d+/${PREFIX}$`));
    assert.match(r.out, new RegExp(`Not restarting ${PREFIX}-tls: .*points at ${FOREIGN}`));
    assert.match(r.out, new RegExp(`Not restarting ${PREFIX}-gone: no plist`));
  });
});

for (const plugin of ['notes', 'code'] as const) {
  const script = `plugins/${plugin}/setup/install-agent.sh`;
  const label = `${PREFIX}-${plugin}`;
  const args = (dir: string) => plugin === 'notes'
    ? ['--bin', join(dir, 'bin', 'silverbullet'), '--notes-dir', join(dir, 'notes'), '--port', '47003']
    : ['--cli', join(dir, 'bin', 'code-cli'), '--token-file', join(dir, 'state', 'code.token'), '--port', '47004'];

  test(`${plugin} install-agent: refuses a foreign plist (apply and uninstall), warns in a dry run, --adopt overrides`, { skip: !isMac && 'macOS only' }, () => {
    withEnv(({ dir, agents, stub, run }) => {
      const before = stubPlist(agents, label, FOREIGN);
      let r = run(script, args(dir));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /warning: --apply would refuse/);
      for (const mode of ['--apply', '--uninstall']) {
        r = run(script, [mode, ...args(dir)]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, new RegExp(`Refusing to touch ${label}`));
      }
      assert.equal(readFileSync(join(agents, `${label}.plist`), 'utf8'), before);
      assert.doesNotMatch(calls(stub), /bootout|bootstrap/);
      r = run(script, ['--apply', '--adopt', ...args(dir)]);
      assert.equal(r.code, 0, r.out);
      assert.equal(plistValue(join(agents, `${label}.plist`), 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
    });
  });

  test(`${plugin} install-agent: replaces its own plist and stamps it`, { skip: !isMac && 'macOS only' }, () => {
    withEnv(({ dir, agents, stub, run }) => {
      stubPlist(agents, label, REPO);
      const r = run(script, ['--apply', ...args(dir)]);
      assert.equal(r.code, 0, r.out);
      assert.match(calls(stub), new RegExp(`bootstrap gui/\\d+ ${agents}/${label}\\.plist`));
      assert.equal(plistValue(join(agents, `${label}.plist`), 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
    });
  });
}

test('setup-auth --rotate: refused before the token changes when the server plist is foreign; restarts its own', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ dir, agents, stub, run }) => {
    const token = join(dir, 'state', 'token');
    writeFileSync(token, 'x'.repeat(32), { mode: 0o600 });
    stubPlist(agents, PREFIX, FOREIGN);
    writeFileSync(join(stub, `loaded-${PREFIX}`), '');
    let r = run('scripts/setup-auth.sh', ['--hostname', 'wh.test', '--apply', '--rotate']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Refusing to touch/);
    assert.equal(readFileSync(token, 'utf8'), 'x'.repeat(32));
    assert.doesNotMatch(calls(stub), /kickstart/);

    stubPlist(agents, PREFIX, REPO);
    r = run('scripts/setup-auth.sh', ['--hostname', 'wh.test', '--apply', '--rotate']);
    assert.equal(r.code, 0, r.out);
    assert.notEqual(readFileSync(token, 'utf8'), 'x'.repeat(32));
    assert.match(calls(stub), new RegExp(`kickstart -k gui/\\d+/${PREFIX}\\n`));
  });
});

test('update.sh: no upstream skips the pull with a note and still installs, builds and restarts', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, REPO);
    writeFileSync(join(stub, 'list'), `-\t0\t${PREFIX}\n`);
    let r = run('scripts/update.sh', []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /has no upstream: not pulling/);
    assert.doesNotMatch(r.out, /\(stub\) pull/);
    assert.equal(readFileSync(join(stub, 'pnpm-calls'), 'utf8'), 'install --frozen-lockfile\nbuild\n');
    assert.match(calls(stub), new RegExp(`kickstart -k gui/\\d+/${PREFIX}\\n`));

    writeFileSync(join(stub, 'upstream'), '');
    r = run('scripts/update.sh', ['--no-restart']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pulling \(.* from origin\/main\)…\n\(stub\) pull/);
    r = run('scripts/update.sh', ['--no-pull', '--no-restart']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /--no-pull: building what's checked out/);
    assert.doesNotMatch(r.out, /\(stub\) pull/);
  });
});

// --- Linux: systemd user units ------------------------------------------------------------------------------------

/** A unit like the scripts write: `repo` in Environment=WORK_HUB_REPO (or, with `legacy`, only in WorkingDirectory). */
function stubUnit(units: string, label: string, repo: string, legacy = false): string {
  const file = join(units, `${label}.service`);
  writeFileSync(file, `[Unit]
Description=${label}

[Service]
WorkingDirectory=${repo}
${legacy ? '' : `Environment="WORK_HUB_REPO=${repo}"\n`}ExecStart="/usr/bin/true"

[Install]
WantedBy=default.target
`);
  return readFileSync(file, 'utf8');
}

const sdCalls = (stub: string) => (existsSync(join(stub, 'sd-calls')) ? readFileSync(join(stub, 'sd-calls'), 'utf8') : '');
const unitLines = (file: string, key: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
const withLinux = (fn: (e: Env) => void) => withEnv(fn, 'Linux');

test('linux: setup-lan --apply writes stamped units, starts them with systemctl --user, leaves -term alone', () => {
  withLinux(({ dir, agents, stub, run }) => {
    stubUnit(agents, PREFIX, REPO);
    stubUnit(agents, `${PREFIX}-tls`, REPO, true); // an older unit of this checkout: WorkingDirectory only
    const term = stubUnit(agents, `${PREFIX}-term`, REPO);
    const r = run(LAN[0], [...LAN[1], '--no-link']);
    assert.equal(r.code, 0, r.out);
    const c = sdCalls(stub);
    assert.match(c, /--user daemon-reload\n/);
    assert.match(c, new RegExp(`--user enable --now ${PREFIX}\\.service\\n`));
    assert.match(c, new RegExp(`--user enable --now ${PREFIX}-tls\\.service\\n`));
    assert.doesNotMatch(c, /-term/);
    assert.equal(calls(stub), '', 'launchctl is never called on Linux');
    assert.equal(readFileSync(join(agents, `${PREFIX}-term.service`), 'utf8'), term);
    const server = join(agents, `${PREFIX}.service`);
    assert.deepEqual(unitLines(server, 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
    assert.ok(unitLines(server, 'Environment').includes('"WORK_HUB_HOSTNAME=wh.test"'));
    assert.match(unitLines(server, 'ExecStart')[0]!, new RegExp(`^"[^"]*node" "${REPO}/server/index\\.ts"$`));
    assert.deepEqual(unitLines(server, 'Restart'), ['always']);
    assert.deepEqual(unitLines(server, 'StandardOutput'), [`append:${join(dir, 'xdg-state', 'work-hub', 'logs', `${PREFIX}.log`)}`]);
    const path = unitLines(server, 'Environment').find((l) => l.startsWith('"PATH='))!;
    // node's and gh's dirs (wherever they are), then fixed dirs without macOS's /opt/homebrew/bin and /usr/sbin.
    assert.ok(path.endsWith(`:${join(dir, 'home')}/.local/bin:/usr/local/bin:/usr/bin:/bin"`), path);
    assert.doesNotMatch(path, /\/usr\/sbin/);
    assert.equal(unitLines(join(agents, `${PREFIX}-tls.service`), 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
    assert.match(r.out, /loginctl enable-linger/);
  });
});

test('linux: setup-lan refuses a unit of another checkout (touching nothing) and --adopt takes it over', () => {
  withLinux(({ agents, stub, run }) => {
    const before = stubUnit(agents, PREFIX, FOREIGN);
    let r = run('scripts/setup-lan.sh', ['--hostname', 'wh.test']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`warning: --apply would refuse ${PREFIX}: .*points at ${FOREIGN}`));
    r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`Refusing to touch ${PREFIX}: .*${PREFIX}\\.service points at ${FOREIGN}`));
    assert.equal(sdCalls(stub), '');
    assert.equal(readFileSync(join(agents, `${PREFIX}.service`), 'utf8'), before);
    r = run(LAN[0], [...LAN[1], '--adopt', '--no-link']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Adopting ${PREFIX} \\(--adopt\\)`));
    assert.match(sdCalls(stub), new RegExp(`--user disable --now ${PREFIX}\\.service\\n`));
    assert.equal(unitLines(join(agents, `${PREFIX}.service`), 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
  });
});

test('linux: a unit running a .ts outside this checkout is foreign even when it names this checkout', () => {
  withLinux(({ agents, run }) => {
    writeFileSync(join(agents, `${PREFIX}.service`), `[Service]\nEnvironment="WORK_HUB_REPO=${REPO}"\nExecStart="/usr/bin/node" "${FOREIGN}/server/index.ts"\n`);
    const r = run(LAN[0], [...LAN[1]]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`runs ${FOREIGN}/server/index\\.ts, outside this checkout`));
  });
});

test('linux: setup-lan --uninstall disables and removes its own units, keeps -term without --with-term', () => {
  withLinux(({ agents, stub, run }) => {
    stubUnit(agents, PREFIX, REPO);
    stubUnit(agents, `${PREFIX}-tls`, REPO);
    stubUnit(agents, `${PREFIX}-term`, REPO);
    const r = run('scripts/setup-lan.sh', ['--uninstall']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(agents, `${PREFIX}.service`)));
    assert.ok(!existsSync(join(agents, `${PREFIX}-tls.service`)));
    assert.ok(existsSync(join(agents, `${PREFIX}-term.service`)));
    const c = sdCalls(stub);
    assert.match(c, new RegExp(`--user disable --now ${PREFIX}\\.service\\n`));
    assert.doesNotMatch(c, /-term/);
  });
});

test('linux: update.sh restarts only units whose file points at this checkout, never -term', () => {
  withLinux(({ agents, stub, run }) => {
    stubUnit(agents, PREFIX, REPO);
    stubUnit(agents, `${PREFIX}-tls`, FOREIGN);
    stubUnit(agents, `${PREFIX}-term`, REPO);
    writeFileSync(join(stub, 'units'), [PREFIX, `${PREFIX}-tls`, `${PREFIX}-term`, `${PREFIX}-gone`, 'other.thing']
      .map((u) => `${u}.service loaded active running ${u}`).join('\n') + '\n');
    let r = run('scripts/update.sh', ['--no-restart']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`--no-restart: not restarting ${PREFIX}\\n  \\(each: systemctl --user restart <label>\\.service\\)`));
    r = run('scripts/update.sh', []);
    assert.equal(r.code, 0, r.out);
    const restarts = sdCalls(stub).split('\n').filter((l) => l.startsWith('--user restart'));
    assert.deepEqual(restarts, [`--user restart ${PREFIX}.service`], r.out);
    assert.match(r.out, new RegExp(`Not restarting ${PREFIX}-tls: .*points at ${FOREIGN}`));
    assert.match(r.out, new RegExp(`Not restarting ${PREFIX}-gone: no unit at ${agents}/${PREFIX}-gone\\.service`));
    assert.equal(calls(stub), '');
  });
});

for (const plugin of ['notes', 'code'] as const) {
  const script = `plugins/${plugin}/setup/install-agent.sh`;
  const label = `${PREFIX}-${plugin}`;
  const args = (dir: string) => plugin === 'notes'
    ? ['--bin', join(dir, 'bin', 'silverbullet'), '--notes-dir', join(dir, 'notes'), '--port', '47003']
    : ['--cli', join(dir, 'bin', 'code-cli'), '--token-file', join(dir, 'state', 'code.token'), '--port', '47004'];

  test(`linux: ${plugin} install-agent writes a stamped unit, refuses a foreign one, --adopt overrides, --uninstall removes`, () => {
    withLinux(({ dir, agents, stub, run }) => {
      const unit = join(agents, `${label}.service`);
      let r = run(script, ['--apply', ...args(dir)]);
      assert.equal(r.code, 0, r.out);
      assert.equal(unitLines(unit, 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
      assert.match(unitLines(unit, 'ExecStart')[0]!, plugin === 'notes' ? /silverbullet" "--single" "-L" "127\.0\.0\.1"/ : /code-cli" "serve-web"/);
      assert.match(sdCalls(stub), new RegExp(`--user enable --now ${label}\\.service\\n`));

      const before = stubUnit(agents, label, FOREIGN);
      for (const mode of ['--apply', '--uninstall']) {
        r = run(script, [mode, ...args(dir)]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, new RegExp(`Refusing to touch ${label}`));
      }
      assert.equal(readFileSync(unit, 'utf8'), before);
      r = run(script, ['--apply', '--adopt', ...args(dir)]);
      assert.equal(r.code, 0, r.out);
      assert.equal(unitLines(unit, 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
      r = run(script, ['--uninstall', ...args(dir)]);
      assert.equal(r.code, 0, r.out);
      assert.ok(!existsSync(unit));
    });
  });
}

test('linux: setup-auth copies the link with xclip (never printing it) and --rotate restarts the server unit', () => {
  withLinux(({ dir, agents, stub, run }) => {
    const token = join(dir, 'state', 'token');
    writeFileSync(token, 'x'.repeat(32), { mode: 0o600 });
    stubUnit(agents, PREFIX, FOREIGN);
    writeFileSync(join(stub, `active-${PREFIX}.service`), '');
    let r = run('scripts/setup-auth.sh', ['--hostname', 'wh.test', '--apply', '--rotate']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Refusing to touch/);
    assert.equal(readFileSync(token, 'utf8'), 'x'.repeat(32));

    stubUnit(agents, PREFIX, REPO);
    r = run('scripts/setup-auth.sh', ['--hostname', 'wh.test', '--apply', '--rotate']);
    assert.equal(r.code, 0, r.out);
    const t = readFileSync(token, 'utf8');
    assert.notEqual(t, 'x'.repeat(32));
    assert.match(sdCalls(stub), new RegExp(`--user restart ${PREFIX}\\.service\\n`));
    assert.equal(readFileSync(join(stub, 'clipboard'), 'utf8'), `https://wh.test:47002/login#t=${t}`);
    assert.ok(!r.out.includes(t), 'the token is never printed');
  });
});

test('linux: unit-file quoting round-trips through the ownership check (spaces, quotes, %, $)', () => {
  withLinux(({ dir, run }) => {
    // The lib's own writer and reader, on a value with every character systemd treats specially.
    const odd = join(dir, 'a dir "q" 100% $HOME');
    const r = spawnSync('bash', ['-c', `REPO="$1"; source "$2/scripts/lib/launchd.sh"; f="$AGENTS_DIR/x.service"; mkdir -p "$AGENTS_DIR"
      systemd_unit_body x "$REPO" /tmp/x.log K "v %i \\"z\\"" -- /bin/echo "$REPO/a.ts" > "$f"
      printf '%s\\n' "$(launchd_plist_repo "$f")"; systemd_unit_args "$f"`, '_', odd, REPO],
      { env: { ...process.env, WORK_HUB_PLATFORM: 'Linux', WORK_HUB_SYSTEMD_USER_DIR: join(dir, 'agents') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').slice(0, 3), [odd, '/bin/echo', `${odd}/a.ts`]);
    void run;
  });
});

test('linux: trust-ca-linux is a dry run by default, refuses when sudo would prompt, and --apply runs mkcert -install', { skip: process.getuid?.() === 0 && 'running as root: the script needs no sudo then' }, () => {
  withLinux(({ dir, stub, run }) => {
    const bin = join(dir, 'bin');
    const ca = join(dir, 'ca');
    mkdirSync(ca);
    writeFileSync(join(ca, 'rootCA.pem'), execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/null',
      '-subj', '/CN=mkcert test CA', '-days', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    writeFileSync(join(bin, 'mkcert'), `#!/bin/sh\n[ "$1" = -CAROOT ] && { echo "${ca}"; exit 0; }\necho "mkcert $*" >> "$STUB_DIR/mkcert-calls"\n`);
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\n[ -e "$STUB_DIR/sudo-ok" ]\n');
    chmodSync(join(bin, 'sudo'), 0o755);
    const mkcertCalls = () => (existsSync(join(stub, 'mkcert-calls')) ? readFileSync(join(stub, 'mkcert-calls'), 'utf8') : '');
    let r = run('scripts/trust-ca-linux.sh', []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Dry run[\s\S]*would run: mkcert -install \(adds mkcert test CA/);
    assert.match(r.out, /run `sudo -v` first/);
    r = run('scripts/trust-ca-linux.sh', ['--apply']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /sudo would prompt here: run `sudo -v` first/);
    assert.equal(mkcertCalls(), '');
    writeFileSync(join(stub, 'sudo-ok'), '');
    r = run('scripts/trust-ca-linux.sh', ['--apply']);
    assert.equal(r.code, 0, r.out);
    assert.equal(mkcertCalls(), 'mkcert -install\n');
    assert.match(r.out, /Trusted: mkcert test CA/);
  });
});

test('linux: share-ca copies only the certificate to XDG_DOWNLOAD_DIR and opens that folder', () => {
  withLinux(({ dir, stub, run }) => {
    const ca = join(dir, 'rootCA.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
    const downloads = join(dir, 'dl');
    let r = run('scripts/share-ca.sh', [], { WORK_HUB_CA_CERT: ca, XDG_DOWNLOAD_DIR: downloads });
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(downloads, 'work-hub-rootCA.pem'), 'utf8'), readFileSync(ca, 'utf8'));
    assert.match(r.out, new RegExp(`Copied the root CA certificate to ${downloads}/work-hub-rootCA\\.pem and opened its folder`));
    assert.equal(readFileSync(join(stub, 'xdg-open'), 'utf8'), `${downloads}\n`);
    writeFileSync(ca, '-----BEGIN PRIVATE KEY-----\n');
    r = run('scripts/share-ca.sh', [], { WORK_HUB_CA_CERT: ca, XDG_DOWNLOAD_DIR: downloads });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /contains a private key; refusing/);
  });
});

// --- scripts/setup.sh: a fresh clone to a running localhost app ---------------------------------------------------

const pnpmCalls = (stub: string) => (existsSync(join(stub, 'pnpm-calls')) ? readFileSync(join(stub, 'pnpm-calls'), 'utf8') : '');

test('setup.sh dry run: checks pass, says what --apply does, touches nothing', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    const r = run('scripts/setup.sh', []);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /✓ claude CLI, signed in/);
    assert.match(r.out, new RegExp(`install the background service ${PREFIX} .*http://127\\.0\\.0\\.1:47001`));
    assert.match(r.out, /Run: scripts\/setup\.sh --apply/);
    assert.equal(calls(stub), '');
    assert.equal(pnpmCalls(stub), '');
    assert.ok(!existsSync(join(agents, `${PREFIX}.plist`)));
  });
});

test('setup.sh: claude signed out is listed with its fix; --apply then refuses before installing anything', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ stub, run }) => {
    writeFileSync(join(stub, 'logged-out'), '');
    let r = run('scripts/setup.sh', []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ claude isn't signed in — run `claude` once in a terminal and sign in/);
    r = run('scripts/setup.sh', ['--apply']);
    assert.equal(r.code, 1, r.out);
    assert.equal(pnpmCalls(stub), '');
    assert.equal(calls(stub), '');
  });
});

test('setup.sh: a port already taken (no agent of ours) is listed with WORK_HUB_PORT as the fix', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ stub, run }) => {
    writeFileSync(join(stub, 'listening'), '');
    const r = run('scripts/setup.sh', []);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /port 47001 is already in use .*WORK_HUB_PORT/);
  });
});

test('setup.sh --apply installs, builds, writes a stamped localhost plist (no hostname), loads it and waits', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    const r = run('scripts/setup.sh', ['--apply']);
    assert.equal(r.code, 0, r.out);
    assert.equal(pnpmCalls(stub), 'install --frozen-lockfile\nbuild\n');
    const plist = join(agents, `${PREFIX}.plist`);
    assert.equal(plistValue(plist, 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
    assert.equal(plistValue(plist, 'EnvironmentVariables.WORK_HUB_PORT'), '47001');
    assert.equal(plistValue(plist, 'EnvironmentVariables.NODE_ENV'), 'production');
    assert.throws(() => plistValue(plist, 'EnvironmentVariables.WORK_HUB_HOSTNAME'));
    assert.equal(plistValue(plist, 'ProgramArguments.1'), join(REPO, 'server', 'index.ts'));
    assert.match(calls(stub), new RegExp(`bootstrap gui/\\d+ ${plist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.out, /work-hub is running: open http:\/\/127\.0\.0\.1:47001/);
  });
});

test('setup.sh --apply keeps this checkout\'s existing agent as it is (e.g. LAN mode) and restarts it', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    const before = stubPlist(agents, PREFIX, REPO);
    writeFileSync(join(stub, `loaded-${PREFIX}`), '');
    writeFileSync(join(stub, 'listening'), '');
    const r = run('scripts/setup.sh', ['--apply']);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(agents, `${PREFIX}.plist`), 'utf8'), before);
    assert.match(calls(stub), new RegExp(`kickstart -k gui/\\d+/${PREFIX}\\n`));
    assert.doesNotMatch(calls(stub), /bootstrap/);
  });
});

test('setup.sh refuses an agent of another checkout (touching nothing); --adopt takes it over', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    const before = stubPlist(agents, PREFIX, FOREIGN);
    let r = run('scripts/setup.sh', ['--apply']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /belongs to another checkout/);
    assert.equal(readFileSync(join(agents, `${PREFIX}.plist`), 'utf8'), before);
    assert.equal(calls(stub), '');
    r = run('scripts/setup.sh', ['--apply', '--adopt']);
    assert.equal(r.code, 0, r.out);
    assert.equal(plistValue(join(agents, `${PREFIX}.plist`), 'EnvironmentVariables.WORK_HUB_REPO'), REPO);
    assert.match(calls(stub), new RegExp(`bootout gui/\\d+/${PREFIX}\\nbootstrap `));
    assert.doesNotMatch(calls(stub), /kickstart/);
  });
});

test('setup.sh --uninstall removes its own agent and refuses another checkout\'s', { skip: !isMac && 'macOS only' }, () => {
  withEnv(({ agents, stub, run }) => {
    stubPlist(agents, PREFIX, REPO);
    let r = run('scripts/setup.sh', ['--uninstall']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(agents, `${PREFIX}.plist`)));
    assert.match(calls(stub), new RegExp(`bootout gui/\\d+/${PREFIX}\\n`));
    stubPlist(agents, PREFIX, FOREIGN);
    r = run('scripts/setup.sh', ['--uninstall']);
    assert.equal(r.code, 1, r.out);
    assert.ok(existsSync(join(agents, `${PREFIX}.plist`)));
  });
});

test('linux: setup.sh --apply writes a stamped localhost unit and starts it with systemctl --user', () => {
  withLinux(({ agents, stub, run }) => {
    const r = run('scripts/setup.sh', ['--apply']);
    assert.equal(r.code, 0, r.out);
    const unit = join(agents, `${PREFIX}.service`);
    assert.equal(unitLines(unit, 'Environment')[0], `"WORK_HUB_REPO=${REPO}"`);
    assert.ok(unitLines(unit, 'Environment').includes('"WORK_HUB_PORT=47001"'));
    assert.ok(!unitLines(unit, 'Environment').some((l) => l.includes('WORK_HUB_HOSTNAME')));
    assert.match(unitLines(unit, 'ExecStart')[0]!, new RegExp(`^"[^"]*node" "${REPO}/server/index\\.ts"$`));
    assert.match(sdCalls(stub), new RegExp(`--user enable --now ${PREFIX}\\.service\\n`));
    assert.equal(calls(stub), '');
  });
});
