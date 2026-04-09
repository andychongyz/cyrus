---
name: investigate
description: Research the codebase to answer questions. Search for relevant files, gather context, and provide clear answers.
---

# Investigate

Research the codebase and provide a clear, direct answer to the question.

## Approach

1. **Search** — Search the codebase for relevant files, functions, and patterns
2. **Read** — Read necessary files to understand the implementation
3. **Gather context** — Use tools as needed to collect comprehensive information
4. **Answer** — Provide a clear, direct answer using your findings

## Data Retrieval

If the question involves production data, database records, or Shopify API data, check whether the `readonly-rails-console` skill is available. If it is, use its MCP tools (`safe_query`, `console_execute`, `model_info`) to retrieve real data that supports your answer. Concrete data is more useful than pointing at code that queries it. Only use when data retrieval would meaningfully improve the answer.

## Answer Format

- Present in Linear-compatible markdown
- Use `+++Section Name\n...\n+++` for collapsible sections with detailed information
- Include code references with file paths and line numbers
- For @mentions, use the Linear profile URL format from `<assignee>` context (e.g. `https://linear.app/<workspace>/profiles/<username>`)

## Response Style

- **Lead with the answer.** State the conclusion or finding first, then provide supporting evidence.
- **Be concise but technically complete.** Include file paths, function names, and relevant code snippets. Omit narrative about your search process.
- **No preamble or restating the question.** Do not begin with "Great question" or restate what the user asked.
- **No filler sections.** If the answer is short, let it be short. Do not pad with obvious context.
- **Use collapsible sections for depth.** Put extended code listings or secondary details inside `+++` blocks so the top-level answer stays scannable.
- **Omit dead ends.** Do not mention files or paths you explored that turned out to be irrelevant.
