# keep-awake

Stops the Mac from idle-sleeping while a Claude session is working, so a long turn survives you walking away. It does
nothing otherwise: an idle Mac, or one with the lid closed, sleeps as usual (so the battery isn't drained in a bag).

While some session has status `working` (a turn running, or subagents/background shells in flight), and for a grace
period after the last one stops, the plugin holds `caffeinate -i -w <server pid>`. `-i` blocks only idle system sleep:
the display still sleeps, closing the lid still suspends the Mac, and `-w` ends the hold if the server dies. Sessions
waiting on you (`needs-input`) or idle don't count.

Linux and Windows (experimental, never run there yet; `keepAwakeCommand` in `server/lib/platform.ts`): Linux holds
`systemd-inhibit --what=idle:sleep` around `tail --pid=<server pid> -f /dev/null` (logind ignores inhibitors for the lid
switch by default, so the lid still suspends); Windows runs a hidden PowerShell that holds
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` until the server exits (the screen still turns off). Fix
and commit back whatever doesn't work there.

With no browser open the `claude` source doesn't poll, so the plugin refreshes it itself (`claude agents`, free, no tokens).

## Settings (`WORK_HUB_KEEP_AWAKE_<KEY>` env or plugins.json `settings.keep-awake.<key>`)

| key | default | meaning |
| --- | --- | --- |
| `graceMs` | 120000 | stay awake this long after the last session stops working (bridges the gap between turns) |
| `pollMs` | 30000 | how often to check sessions when nobody is watching |

## Caveats

- Closed lid always sleeps (on battery, and on AC without an external display), and a sleeping Mac runs no sessions: they
  resume on wake.
- Waking for new requests is a macOS setting, not something an app can do: `sudo pmset -a womp 1` ("wake for network
  access"). On a laptop it mostly works on AC power with Ethernet; Wi-Fi wake needs another Apple device acting as a
  Sleep Proxy.
