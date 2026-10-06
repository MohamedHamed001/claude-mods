Run a read-only agy (Google Antigravity) code review of the local changes, mirroring /codex-review.
agy job ${JOB_ID}.

Focus from the user (may be empty): ${TASK}

This command is review-only: do not fix anything, and do not say you are about to.

Base ref: ${BASE}

1. Collect what to review into `${JOB_DIR}/diff.patch`:
   - with a base ref, `git diff <base>...HEAD`;
   - otherwise the working tree: `git diff HEAD`, plus untracked files from
     `git status --short --untracked-files=all` (add their content to the file).
   If there is nothing to review, say so and stop.
2. Write `${JOB_DIR}/brief.md`:
   ${REVIEW_STYLE}
   Ask for findings ordered by severity, each with file:line, what is wrong, why it matters and a
   suggested fix, then a one-line verdict. The patch is at `${JOB_DIR}/diff.patch`; agy may read
   the repository to check context. Tell agy plainly not to run any shell command, not even git:
   headless agy cannot ask for approval, so the first command fails the whole run.
3. Run the relay read-only in one shell call${BACKGROUND_NOTE}:

```bash
node "${RELAY}" --brief "${JOB_DIR}/brief.md" --out-dir "${JOB_DIR}" --add-dir "${JOB_DIR}" --model ${MODEL} --read-only --timeout 20m
```

4. Show agy's findings from `${JOB_DIR}/result.json` (`finalMessage`) as they are. Then mark any
   finding you checked against the code and found wrong; fast models are less careful.
