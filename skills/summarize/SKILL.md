---
name: summarize
description: Format a final summary message for Linear. Your output is automatically streamed to the Linear agent session — just format it well, do not post it yourself.
---

# Summarize

Format a final summary of the work completed. Your output will be automatically rendered inside Linear — just write it as your response. Do **not** use any tool to post or save it.

## For Code Changes

Cover the following:
1. **Work Completed** — What was accomplished (1-2 sentences) and key outcome
2. **Key Details** — Files modified, important changes, PR link if created
3. **Status** — Completion status and any follow-up needed

### Format

- Aim for 3-5 paragraphs maximum
- Use clear, professional language suitable for Linear
- Use markdown formatting for readability
- **Collapsible sections**: Wrap "Changes Made" and "Files Modified" in `+++Section Name\n...\n+++`
- **@mentions**: Use the Linear profile URL format from `<assignee>` context (e.g. `https://linear.app/<workspace>/profiles/<username>`)

### Example

```
## Summary

[Brief description of what was done]

+++Changes Made
- [Key change 1]
- [Key change 2]
+++

+++Files Modified
- [File 1]
- [File 2]
+++

## Status

[Current status and any next steps]

[PR link if applicable]
```

## For Questions / Research

When summarizing the result of an `investigate` skill (no code was changed):

1. **Answer** — Present the answer directly. Do not add "Work Completed" or "Files Modified" sections.
2. **References** — List relevant file paths and symbols in a collapsible section if there are more than 3.
3. **Follow-up** — Only if there are genuine open questions or caveats.

### Format

- Lead with the answer. Do not restate the question.
- Keep it as short as the answer allows — do not pad.
- Use `+++References\n...\n+++` for supporting file paths and code pointers.
- **@mentions**: Use the Linear profile URL format from `<assignee>` context (e.g. `https://linear.app/<workspace>/profiles/<username>`)

### Example

```
## Answer

[Direct answer to the question with key technical details]

+++References
- `path/to/relevant/file.ts` — [brief note]
- `path/to/other/file.ts:42` — [relevant function or logic]
+++
```
