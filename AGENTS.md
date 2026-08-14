<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git publish defaults

When I explicitly ask to “commit và push” (or an equivalent request):

- Commit the intended changes and push them to the `main` branch by default.
- Use the GitHub account `hainguyenpy195-coder` for the push.
- Use `hainguyenpy195-coder` as the commit author when the repository Git configuration is available.
- Do not open a pull request unless I explicitly ask for one.
- Do not stage unrelated or untracked files silently. If the worktree contains unrelated changes, keep them out of the commit and explain what remains.
- If moving changes to `main` would risk losing work or cause a conflict, stop and explain before proceeding.
