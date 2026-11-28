# Lessons

## Active
### L1: Don't wait on the whole server suite on Windows without a timeout
- Do: run `server/test` with `--test-timeout` and exclude `livetv-followups.test.ts` locally; CI (Linux) runs it.
- Why: `livetv-followups.test.ts` hung for 25+ min on this Windows machine, also on untouched main (2026-11-28).
- Areas: server/test | Added 2026-11-28 | Last confirmed 2026-11-28

### L2: Multi-line code edits go through a script file, not a bash heredoc
- Do: write the edit script with the Write tool, then run it.
- Why: a heredoc holding JSX with quotes/backticks failed to parse and applied nothing (2026-11-28).
- Areas: tooling | Added 2026-11-28 | Last confirmed 2026-11-28

### L3: Work in your own worktree when other sessions may share the checkout
- Do: `git worktree add ../mediamax-nuvio <branch>` and work only there; never commit in a folder someone else switches branches in.
- Why: another session switched the shared checkout to main mid-change, so the phase 1 commit landed on local main (2026-11-28).
- Areas: git | Added 2026-11-28 | Last confirmed 2026-11-28

### L4: Spreading a handler bag after your own props replaces them
- Do: compose event handlers (call both) instead of `onFocus={…} {...peekHandlers(item)}`.
- Why: the TV focus trailers never started because `peekHandlers` came later with its own onFocus/onBlur (review, 2026-11-28).
- Areas: web/src/components | Added 2026-11-28 | Last confirmed 2026-11-28

## Retired
