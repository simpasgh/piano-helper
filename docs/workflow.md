# Release & merge workflow

The standard operating procedure for shipping Piano Helper safely. Goal: `main` is always
releasable, parallel work never silently overrides anything, history stays clean, and prod
is verified after every release. Owned by IT/DevOps; everyone follows it.

## Branching (trunk-based)

- `main` is the single source of truth and is always deployable.
- All work happens on **short-lived branches**: `feat/...`, `fix/...`, `chore/...`,
  `docs/...`.
- For **parallel work**, use **git worktrees** so two efforts never share a working tree:
  ```bash
  git worktree add ../piano-helper-omr feat/omr-upload
  ```
  Each worktree is an isolated branch; they cannot clobber each other on disk.

## Keep your branch current (no silent overrides)

Before opening a PR and again before merging:
```bash
git fetch origin
git rebase origin/main      # replay your work on top of latest main; resolve conflicts here
```
The branch-protection ruleset **requires the branch to be up to date with `main`** before
merge, so if someone merged in parallel you must rebase first. That is what guarantees a
parallel flow can never overwrite yours.

## Linear history (clean merge tree)

- The ruleset **requires linear history**: no merge commits on `main`.
- Merge PRs with **squash** or **rebase**, never a merge commit.
- Never force-push to `main` (blocked by the ruleset).

## Gates before merge

Every change must clear all of these:

1. **Tests exist and pass.** New logic gets a unit test; a fixed bug gets a regression test.
   `npm test` and the CI workflow must be green.
2. **CI green.** `.github/workflows/ci.yml` runs typecheck + build + tests on the PR. It is
   a **required status check**.
3. **Review done.** The **Tech Lead reviews locally** via `/code-review` (and
   `/security-review` for sensitive changes). Review happens through the Claude Code
   subscription, not in CI, to keep costs at zero.

## Releasing

Run **`/release [version]`**. It performs, in order:

1. `git fetch` + `git rebase origin/main`.
2. `npm ci` + `npm test` + `npm run build` locally.
3. Tech Lead `/code-review` of the diff.
4. Push the branch, open a PR, wait for CI to pass.
5. Merge (squash/rebase, linear).
6. The **deploy workflow** (`.github/workflows/deploy.yml`) builds and deploys `main` to
   Cloudflare Pages.
7. **Prod smoke test** runs against the live `*.pages.dev` URL (`/smoke-test`). Any failure
   is a release-blocker; fix forward immediately so `main` stays green.

## Live QA (on demand, not a gate)

CI proves typecheck/build/unit tests; the prod smoke test only proves the app loads and
plays. Neither one exercises the actual feature, so a change can be fully green and still be
visibly broken. The **QA** role exists to close that gap by driving the real feature in a
browser, but this is **run on demand, not a mandatory gate**: a change is "done" when its
tests, CI, and review pass. Reach for a live QA pass when a change is risky, visual, or
user-facing enough to warrant eyes on the real behavior, or whenever it is requested.

When you do run one:

1. Sync the preview-capable worktree to the just-merged `main`.
2. Drive the app in a real browser: load a representative score, then actually click,
   toggle, seek, and play the specific feature the change shipped.
3. Capture evidence (screenshot of the relevant state + a clean browser console) and check
   the standing checklist in [docs/context/qa.md](context/qa.md) for regressions.
4. PASS or FAIL. On FAIL, file or reopen a bug and fix forward; `main` stays green. Never
   record a visual/interactive pass that was not actually observed.

## Post-release backlog reconciliation (mandatory)

A shipped change can quietly invalidate tickets still sitting in the backlog: it may
resolve them, make their premise obsolete, or leave their description citing numbers,
engines, or behavior that no longer hold. Stale tickets waste a future session's time and
can send it down a dead path. So **after every release, the Product Manager role reviews
the open backlog against what just shipped** and reconciles it:

1. Read the merged change and the open issues in its area.
2. For each affected ticket decide: **close** (resolved or made moot), **re-scope** (still
   valid but the description now cites stale facts; edit it, or prepend a dated update note
   that supersedes the stale parts), or **keep** (unaffected).
3. Apply the verdicts (close with a rationale comment that references the shipping PR; edit
   bodies), and record the reconciliation in [docs/context/product.md](context/product.md).

Like the QA gate, this is part of "done": a release is not finished until the backlog it
touched has been reconciled.

## Hotfix

Same flow on a `fix/...` branch. Do not skip tests or smoke test; speed comes from a small
diff, not from skipping gates.
