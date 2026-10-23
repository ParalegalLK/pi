import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compactToolResult, mcpTools } from "../mcp/server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("MCP exposes native legal review and drafting tools instead of external reviewer/drafter tools", async (t) => {
	const child = spawn(process.execPath, ["junior-silva/mcp/server.mjs"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill());
	let buffer = "";
	const responses = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (line.trim()) responses.push(JSON.parse(line));
		}
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("MCP tool listing timed out")), 4000);
		const check = () => {
			if (responses.some((item) => item.id === 2)) { clearTimeout(timer); resolve(); }
			else setTimeout(check, 10);
		};
		check();
	});
	const list = responses.find((item) => item.id === 2)?.result?.tools || [];
	const names = new Set(list.map((tool) => tool.name));
	for (const name of ["review_prepare_document_set", "review_record_checkpoint_outcome", "review_finalize_document", "legal_precedent_search", "legal_precedent_read", "legal_validate_draft", "legal_source_retrieve_details"]) assert.ok(names.has(name), name);
	for (const name of ["legal_read_document_set", "legal_build_clause_inventory", "legal_audit_commercial_coverage", "legal_validate_review_findings", "legal_render_review_report"]) assert.ok(!names.has(name), name);
	assert.ok(!names.has("reviewer_perera_start_review"));
	assert.ok(!names.has("drafter_weeramantry_draft_or_revise"));
});

test("MCP keeps review HTML in structured content and gives Pi compact download metadata", () => {
	const markup = `:::artifact{\"type\":\"text/html\"}\n${"<p>review</p>".repeat(10_000)}\n:::`;
	const result = compactToolResult("review_finalize_document", {
		operation_id: "review-final-example",
		completion: "review-artifacts-ready",
		reviews: [{
			target_id: "review-target-1",
			source_filename: "agreement.pdf",
			reviewed_docx: { name: "Reviewed_agreement.docx", media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", download_url: "https://example.test/files/docx", local_path: "/data/artifacts/secret.docx", file_uri: "file:///data/artifacts/secret.docx" },
			review_markdown: { name: "legal-review-agreement.md", media_type: "text/markdown", download_url: "https://example.test/files/markdown", local_path: "/data/artifacts/secret.md" },
			annotation_coverage: { annotated_count: 3 },
			artifact_markup: markup,
		}],
		artifact_markup: markup,
	});
	const text = JSON.stringify(result);
	assert.ok(text.length < 4_000);
	assert.match(text, /https:\/\/example\.test\/files\/docx/);
	assert.doesNotMatch(text, /artifact_markup|local_path|file_uri|<p>review<\/p>/);
});

test("MCP directs indexed-value discovery and case catalogues to the structured direct source tool", () => {
	const tool = mcpTools.find((candidate) => candidate.name === "legal_source_retrieve_details");
	assert.ok(tool);
	assert.ok(tool.description.includes("case_catalog"));
	assert.ok(tool.description.includes("facet_values"));
	for (const operation of ["case_catalog", "facet_values", "amendment_catalog", "capabilities"]) assert.ok(tool.inputSchema.properties.operation.enum.includes(operation), operation);
	for (const property of ["subject_query", "judge_name", "judge_labels", "facet_field", "facet_query", "decision_year", "decision_month", "court", "report", "report_year", "volume_num", "page_num", "action_type", "amendment_year", "page", "page_size"]) assert.ok(tool.inputSchema.properties[property], property);
});
