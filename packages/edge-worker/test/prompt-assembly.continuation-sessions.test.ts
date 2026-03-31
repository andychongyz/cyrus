/**
 * Prompt Assembly Tests - Continuation Sessions
 *
 * Tests prompt assembly for continuation (non-streaming, non-new) sessions.
 */

import { describe, expect, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Continuation Sessions", () => {
	it("should wrap comment in XML with author and timestamp", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Please fix the bug")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Please fix the bug
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("should include attachments if present", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Here's more context")
			.withCommentAuthor("Bob Jones")
			.withCommentTimestamp("2025-01-27T13:30:00Z")
			.withAttachments(`
## New Attachments from Comment

Downloaded 1 new attachment.

### New Attachments
1. attachment_0001.txt - Original URL: https://linear.app/attachments/error-log.txt
   Local path: /path/to/attachments/attachment_0001.txt

You can use the Read tool to view these files.
`)
			.expectUserPrompt(`<new_comment>
  <author>Bob Jones</author>
  <timestamp>2025-01-27T13:30:00Z</timestamp>
  <content>
Here's more context
  </content>
</new_comment>


## New Attachments from Comment

Downloaded 1 new attachment.

### New Attachments
1. attachment_0001.txt - Original URL: https://linear.app/attachments/error-log.txt
   Local path: /path/to/attachments/attachment_0001.txt

You can use the Read tool to view these files.
`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment", "attachment-manifest")
			.expectPromptType("continuation")
			.verify();
	});

	it("should default to Unknown author if not provided", async () => {
		const worker = createTestWorker();

		const result = await scenario(worker)
			.continuationSession()
			.withUserComment("Update the docs")
			.build();

		// Verify structure with dynamic timestamp
		expect(result.userPrompt).toContain("<new_comment>");
		expect(result.userPrompt).toContain("<author>Unknown</author>");
		expect(result.userPrompt).toMatch(
			/<timestamp>[\d-]+T[\d:.]+Z<\/timestamp>/,
		);
		expect(result.userPrompt).toContain(
			"<content>\nUpdate the docs\n  </content>",
		);
		expect(result.userPrompt).toContain("</new_comment>");

		expect(result.systemPrompt).toBeUndefined();
		expect(result.metadata.components).toEqual(["user-comment"]);
		expect(result.metadata.promptType).toBe("continuation");
	});

	it("should include base_branch context reminder when resolvedBaseBranches is provided", async () => {
		const worker = createTestWorker([], "ceedar");

		await scenario(worker)
			.continuationSession()
			.withRepository({
				id: "repo-hotfix-test",
				path: "/test/repo",
				baseBranch: "develop",
			})
			.withResolvedBaseBranches({
				"repo-hotfix-test": { branch: "master", source: "commit-ish" },
			})
			.withUserComment("Create the PR")
			.withCommentAuthor("Cyrus")
			.withCommentTimestamp("2025-01-27T14:00:00Z")
			.expectUserPrompt(`<context_reminder>
  <base_branch>master</base_branch>
</context_reminder>

<new_comment>
  <author>Cyrus</author>
  <timestamp>2025-01-27T14:00:00Z</timestamp>
  <content>
Create the PR
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectPromptType("continuation")
			.verify();
	});

	it("should fall back to repo baseBranch when resolvedBaseBranches has no entry for the repo", async () => {
		const worker = createTestWorker([], "ceedar");

		await scenario(worker)
			.continuationSession()
			.withRepository({
				id: "repo-fallback-test",
				path: "/test/repo",
				baseBranch: "develop",
			})
			.withResolvedBaseBranches({
				"some-other-repo": { branch: "master", source: "commit-ish" },
			})
			.withUserComment("Create the PR")
			.withCommentAuthor("Cyrus")
			.withCommentTimestamp("2025-01-27T14:00:00Z")
			.expectUserPrompt(`<context_reminder>
  <base_branch>develop</base_branch>
</context_reminder>

<new_comment>
  <author>Cyrus</author>
  <timestamp>2025-01-27T14:00:00Z</timestamp>
  <content>
Create the PR
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectPromptType("continuation")
			.verify();
	});

	it("should not include context_reminder when no resolvedBaseBranches provided", async () => {
		const worker = createTestWorker([], "ceedar");

		await scenario(worker)
			.continuationSession()
			.withUserComment("Please fix the bug")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Please fix the bug
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});
});
