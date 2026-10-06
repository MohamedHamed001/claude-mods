Hand this task to agy (Google Antigravity), mirroring /codex-rescue. agy job ${JOB_ID}.

Task:
${TASK}

1. Write a brief to `${JOB_DIR}/brief.md` following the agy-delegate skill: the task, the files
   agy may change, what must not change, the acceptance check and the report format. If the user
   gave no task, ask what agy should do instead and stop.
2. Run the relay in one shell call${BACKGROUND_NOTE}:

```bash
node "${RELAY}" --brief "${JOB_DIR}/brief.md" --out-dir "${JOB_DIR}" --model ${MODEL} --dangerously-skip-permissions --timeout 30m
```

   `--dangerously-skip-permissions` is deliberate: agy runs headless and cannot ask for
   permission, so without it every write is refused. The user approved it by running /agy-rescue.
3. When it finishes, read `${JOB_DIR}/result.json`, then review the work yourself: read the diff
   and run the acceptance check. agy saying "done" is not evidence; fast models are less careful.
4. Report what changed and whether the check passed. `/agy-result ${JOB_ID}` shows agy's own report.
