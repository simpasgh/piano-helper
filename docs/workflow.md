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

## Hotfix

Same flow on a `fix/...` branch. Do not skip tests or smoke test; speed comes from a small
diff, not from skipping gates.
