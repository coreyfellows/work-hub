# app-rules

Gives every session work-hub starts the rules its features depend on, so they work for anyone, not just whoever
keeps them in a personal CLAUDE.md.

- **Prompt fragment** `app-rules` (`rules.ts`): the core appends it to the prompt of every session it starts
  (explorer, new session, handoff, PR session, review, manual), but not headless helpers (`purpose: 'headless'`).
  With the plugin off, prompts are unchanged.
- **Skill** `claude/skills/work-hub-rules/SKILL.md`: the same text, for sessions started by hand. Sessions the app
  starts don't load it (they already have the rules in their prompt). To give a hand-started session the rules, run
  `claude --plugin-dir <work-hub repo>/builtin/app-rules/claude`.

Each section has a switch in Settings → App rules (`ruleCommands`, `ruleQuestions`, `ruleVault`, `ruleNotes`; all on except `ruleVault`, for Vault with OIDC sign-in), and `extraRules` is your own text, added last under "Your own rules". They are read for every prompt, so a change applies to the next session; the skill below stays the default text. Nothing is added when every switch is off and there is no extra text.

Covers: runnable one-line `!` commands at column 0 (the Run card only renders for that shape), scripts in
`<state dir>/plugins/app-rules/scripts/<repo>/<worktree>/` (work-hub's own storage, not `/tmp`; the folder is a file-viewer root, and "View script" reads it; non-interactive, dry run by default, `--apply`, `--confirm`, no printed secrets),
follow-ups and decisions through `AskUserQuestion`, with multiple-choice options whenever the answers are a small set, and a "Do nothing" option, Vault login (when switched on), and recording `!` lines and manual
steps in the workspace note. Edit the text in `rules.ts`, then regenerate the skill body to match.
