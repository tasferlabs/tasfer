---
name: write-commit-message
description: Draft and review Git commit messages in Tasfer's repository style. Use when asked to propose, write, revise, or check a commit message for Tasfer changes, or immediately before creating a commit when the user has explicitly requested one.
---

# Write a Tasfer commit message

## Inspect the change

1. Read `git diff --cached --stat` and `git diff --cached` when changes are staged.
2. Fall back to `git diff --stat` and `git diff` when nothing is staged and the user asks for a message for working-tree changes.
3. Read recent non-merge subjects with `git log -20 --no-merges --pretty=format:%s` to match the repository's current vocabulary and emoji choices.
4. Identify the single outcome a reader should understand from the commit. If the changes contain unrelated outcomes, recommend splitting them instead of forcing them into one vague subject.

Do not stage files or create, amend, or otherwise alter a commit unless the user explicitly requests that Git action.

## Draft the subject

Use this shape:

```text
<one relevant emoji> <lowercase imperative summary>
```

- Start with exactly one emoji that represents the change. Prefer an emoji already used for similar changes in recent Tasfer history.
- Follow the emoji with one space.
- Start the summary with a lowercase imperative verb such as `add`, `keep`, `move`, `drop`, `fix`, `stop`, or `let`.
- Describe the user-visible or architectural outcome, not merely the files edited.
- Keep the subject concise and specific. Aim for 72 characters when the meaning remains clear.
- Omit Conventional Commit prefixes and scopes such as `feat:`, `fix:`, or `chore(web):`.
- Omit a trailing period.
- Default to a subject-only message. Add a body only when essential context or reasoning cannot fit naturally in the subject.

## Examples

Match these repository examples:

```text
🚚 move web agent skills out of .claude into .skills
📝 drop the pointer to a reference doc that no longer exists
🪟 split overlapping events into side-by-side lanes
🔑 compare the beta code case-insensitively on both sides
```

Avoid these forms:

```text
feat(web): Move agent skills
🚚 Moved web agent skills.
update files
```

## Return the result

Return only the proposed commit message when the user asks for a message. Do not wrap it in a code fence unless the user requests explanation or alternatives.
