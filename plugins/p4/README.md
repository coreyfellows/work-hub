# p4 (experimental)

A source-control provider for [Perforce](https://www.perforce.com/): a workspace's working copy can be a p4 client
workspace, copied from a **template client** you name in the settings, with its Root set to a new folder under the
worktrees folder. Pick "Perforce (p4)" under Settings → Source control or in the New workspace form, and the setup
session and workspace rules tell Claude how to make and record one.

**Experimental.** Off by default, and tested only against a fake `p4` (a script that records its arguments and prints
canned output); it has never run against a real Perforce server. Fix and commit back whatever doesn't hold up.

It uses your existing p4 setup (`P4PORT`, `P4USER`, tickets, `P4CONFIG`) and never stores credentials. No routes, slots
or web half: it only registers a provider with `ctx.vcs.register` (`provider.ts`).

## What it runs

Every command goes through `ctx.exec.run` (no shell), with `P4CONFIG` set to the server's `P4CONFIG` env var or, when
that's unset, `.p4config`: the same file name the instructions write. `<root>` is the working copy's folder; `<client>` is your client
whose `Root` is exactly `<root>`, found with `p4 -F '%client% %Root%' clients --me`.

| what | command |
| --- | --- |
| detect | `p4 -d <dir> -F %clientRoot% info`, run in the dir: a match when that root contains the dir (the client resolves from the copy's P4CONFIG file) |
| identity | the client's stream, `p4 -F %Stream% client -o <client>` (e.g. `//Game/Main`), else none |
| line | the client itself (what `wh worktree add --branch` records); the head is `p4 -c <client> -F %change% changes -m1 //<client>/...#have` |
| shared lines | none (non-git copies are matched to sessions by path only) |
| inspect | dirty = files in `p4 -c <client> opened`; unsaved = changelists in `p4 changes -s shelved -c <client>` |
| remove | refuses opened files or shelved changelists unless forced (forced: `p4 -c <client> revert //<client>/...` first), then `p4 client -d <client>` and deletes the folder (`fs.rm`, only `<root>`) |
| prereq | `p4 -V` |

What Claude is told to run to make one. `<client>` is `<user>-wh-<workspace id>` (`<user>` from
`p4 -F %userName% info`), or `<user>-wh-<workspace id>-<template>` for a second p4 copy in the workspace; `<name>` is a
ticket's key when it looks like one (`ABC-123`), else a short kebab-case name for the task. Paths are single-quoted in
the prompt, and `awk` reads the new Root from the environment, so no character in it needs escaping. The config file
name is written into the prompt literally (`claude --bg` jobs don't get the server's environment, and nothing exported
lasts between the agent's commands), and Claude is told to run p4 in a copy as `p4 -c <client> …`.

```
p4 client -t <template client> -o <client> | R='<worktrees>/<template>/<name>' awk '/^Root:/ { print "Root:\t" ENVIRON["R"]; next } 1' | p4 client -i
mkdir -p '<worktrees>/<template>/<name>' && cd '<worktrees>/<template>/<name>' && p4 -c <client> sync && echo "P4CLIENT=<client>" > '.p4config'
wh trust '<worktrees>/<template>/<name>'
wh worktree add <workspace id> --path '<worktrees>/<template>/<name>' --vcs p4 --branch <client>
```

It lists the configured templates by name and client; with none configured, Claude is told to ask you which existing
client to copy.

## Settings (plugins.json only)

`templates` is a list, so it's set by hand in `<configDir>/plugins.json` (not in Settings, nor an env var):

```json
{
  "settings": {
    "p4": {
      "templates": [
        { "name": "game", "client": "jdoe-game-template" },
        { "name": "engine", "client": "jdoe-engine-template" }
      ]
    }
  }
}
```

| key | default | meaning |
| --- | --- | --- |
| `templates` | `[]` | clients to copy new working copies from: `name` (also the folder under the worktrees folder) and `client` (an existing client spec, usually one per depot or stream). Entries without both strings are ignored. Read at startup. |

## Caveats

- One client per copy: the first is `<user>-wh-<workspace id>`, any other `<user>-wh-<workspace id>-<template>`.
- Detection needs the client to resolve in the folder (the copy's P4CONFIG file, or `P4CLIENT`); finding the client for
  removal and inspection doesn't (it matches `Root` among your clients).
- Only a folder that is the exact `Root` of one of your clients, and only a client named like work-hub's (`…-wh-…`), is
  ever removed, forced or not. The core also never removes a copy outside the worktrees folder.
- p4 refuses to delete a client with shelved files, forced or not: delete the shelves first (`p4 shelve -d -c <change>`).
- A copy whose folder is already gone is only forgotten: its client stays on the server (`p4 client -d <client>` by hand).
- The config file (`.p4config` by default) sits untracked in the client root; add it to your P4IGNORE if `p4 reconcile`
  or `p4 status` would pick it up.
- A P4CONFIG you set with `p4 set` (not as an env var) isn't seen: with the env var unset the provider uses `.p4config`,
  overriding it. Set `P4CONFIG` in the server's environment to use another name.
- No Diff tab or PR links: those are git-only.
