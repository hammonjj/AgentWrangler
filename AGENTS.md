# Agent instructions

The working rules for this repository are in [`CLAUDE.md`](CLAUDE.md). They apply to every
coding agent, not only Claude Code: read that file before anything else.

The rule most often broken: several agents work here at once, so every task gets its own branch
in its own worktree (CLAUDE.md, "Branches and worktrees"). Commit only your own files by path,
read `git diff <paths>` before committing, and never commit, reset, clean, stash or discard
changes you did not make.
