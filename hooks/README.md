# Hooks (not auto-installed)

Claude Code hook scripts that configure Claude Code itself, not claude-nonstop's
own Slack notifications (those live in `remote/hook-notify.cjs` and are
installed by `claude-nonstop hooks install`). Files here are reference copies —
install manually into `~/.claude/hooks/`.

## git-prefix-guard.py

Companion to the fake-git PATH shadow in `lib/fake-git.js` (see DESIGN.md,
"Fake-Git PATH Shadow for Resume Cache Preservation"). Without it, claude-nonstop
still prevents cache-busting `--resume`s — Claude Code's own git status/log/user
context always shows empty — but Claude never learns the real git state, and any
Bash-tool `git status`/`git log` call during the session would also silently
return the frozen empty values instead of failing loudly.

This hook:

- **SessionStart** — reads the real git state (branch/status/log/user, bypassing
  the shadow via `CLAUDE_NONSTOP_REAL_GIT`) and injects it into context as a
  separate appended block, so Claude always sees the truth regardless of the
  shadow's lock state. Also stores a baseline fingerprint for drift detection.
- **UserPromptSubmit** — on the first prompt of a session, unlocks the shadow
  (writes `.unlocked` in `$CLAUDE_NONSTOP_FAKE_GIT_DIR`) so every subsequent
  `git` call in that session — including Claude's own Bash tool calls — hits the
  real binary. Also detects branch drift (the one thing the shadow can't hide,
  since Claude Code reads `.git/HEAD` directly rather than shelling out to
  `git`) and blocks the prompt once with a warning, since resuming on a
  different branch still forces a full prompt-cache rewrite regardless of the
  shadow.

Unlocking happens on `UserPromptSubmit` rather than at the end of `SessionStart`
because Claude Code doesn't document an ordering guarantee between the two —
unlocking too early (before Claude Code's own native git fetch for that
session) would let the fetch see real values instead of the frozen ones,
reintroducing the exact cache-miss problem the shadow exists to prevent. A
prompt can't be submitted before session init has produced something to send,
so `UserPromptSubmit` is the earliest point with that guarantee.

### Install

```bash
cp hooks/git-prefix-guard.py ~/.claude/hooks/git_prefix_guard.py
chmod +x ~/.claude/hooks/git_prefix_guard.py
```

Then merge into each profile's `settings.json` — `~/.claude/settings.json` and
every `~/.claude-nonstop/profiles/<name>/settings.json` — under the existing
`hooks` block (don't overwrite other registered hooks):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "python3 \"$HOME/.claude/hooks/git_prefix_guard.py\"", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "python3 \"$HOME/.claude/hooks/git_prefix_guard.py\"" }
        ]
      }
    ]
  }
}
```

### Other hooks must bypass the shadow explicitly

`lib/fake-git.js`'s wrapper only intercepts `git` calls targeting the repo
claude-nonstop actually spawned for (checked via `-C <path>`/cwd against the
spawned repo's toplevel) — calls against any other repo always pass through to
the real binary, regardless of lock state. But *within* the spawned repo, any
other hook that shells out to bare `git` (e.g. to check status for an unrelated
reason) still hits the shadow until `git-prefix-guard.py`'s `UserPromptSubmit`
handler unlocks it — and per Claude Code's docs, hooks registered on the same
event run in parallel, so there's no ordering guarantee that a given hook runs
after the unlock. Any such hook should read `CLAUDE_NONSTOP_REAL_GIT` (fall back
to `git` when unset, so it still works without claude-nonstop) instead of
calling `git` directly.
