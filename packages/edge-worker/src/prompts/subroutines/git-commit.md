# Git Commit - Version Control

Changelog updates are complete with PR link. Now commit all changes and push to remote.

## Your Tasks

1. **Stage and Commit Changes**
   - Stage all changes using `git add` — including changelog updates and PR link
   - Write clear, descriptive commit messages following the project's commit message format
   - Ensure commit history is clean and meaningful
   - Follow git workflow instructions in the project's CLAUDE.md

2. **Push to Remote**
   - **PUSH changes** to the remote repository
   - Ensure work is synchronized with the remote repository
   - Verify push was successful

## Co-Author Attribution

Every commit message MUST end with a `Co-Authored-By` trailer for the bot identity. Append this as the last line of the commit message, separated by a blank line from the commit body:

```
Co-Authored-By: {{github_bot_username}} <{{github_app_id}}+{{github_bot_username}}@users.noreply.github.com>
```

Example:

```
feat: add user authentication

Implement OAuth2 login flow with session management.

Co-Authored-By: {{github_bot_username}} <{{github_app_id}}+{{github_bot_username}}@users.noreply.github.com>
```

## Important Notes

- **Only commit after verifications pass** — you're just committing the verified work
- **Follow the project's commit message conventions** - check CLAUDE.md and recent commits for format
- **Include changelog updates** — the changelog and PR link should have been updated in the previous subroutine
- Do NOT touch the changelog — it was handled in the previous subroutine
- **Draft PR** — pushing will update it
- **Always include the Co-Authored-By trailer** — never omit it
- Take as many turns as needed to complete all tasks

## Expected Output

> Note: Do NOT post Linear comments. This output is for internal workflow only.

Provide a brief completion message (1 sentence max):

```
Changes committed and pushed to [branch-name].
```

Example: "Changes committed and pushed to feature/add-user-auth."
