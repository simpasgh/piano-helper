---
description: Run the full gated release (rebase, test, review, PR, merge, deploy, prod smoke test)
argument-hint: "[version, e.g. 0.2.0]"
allowed-tools: Bash, Read, Edit, Grep, Glob, Agent
---

Run a complete, gated release of Piano Helper. Version (optional): `$1`.

Follow [docs/workflow.md](../../docs/workflow.md) exactly. Do not skip a gate. Do not push
or merge directly to `main` outside this flow. Stop and report if any step fails.

Steps:

1. **Sync.** `git fetch origin`, then `git rebase origin/main`. Resolve conflicts now. If the
   current branch is `main`, stop and tell the user to do the work on a `feat/`|`fix/`|`chore/`
   branch first.
2. **Verify locally.** `npm ci`, `npm test`, `npm run build`. All must pass.
3. **Review.** Delegate a code review to the **tech-lead** subagent (it runs `/code-review`,
   plus `/security-review` if the diff touches network, file handling, auth, or
   dependencies). Address blocking findings before continuing.
4. **PR.** Push the branch (`git push -u origin HEAD`) and open a PR with `gh pr create`
   summarizing the change. If `$1` is given, note the intended version in the PR body.
5. **CI.** Wait for required checks to pass (`gh pr checks --watch`).
6. **Merge.** Merge keeping history linear: `gh pr merge --squash --delete-branch` (or
   `--rebase`). Never a merge commit.
7. **Deploy + smoke.** The deploy workflow runs on `main`. After it finishes, run
   `/smoke-test` against the live prod URL and confirm green. If smoke fails, treat it as a
   release-blocker and fix forward immediately.
8. **Tag (optional).** If `$1` was given: `git tag v$1 && git push origin v$1`.

Report a short summary: what shipped, the PR link, deploy status, and the smoke-test result.
