import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
	for (const name of ["review_prepare_document_set", "review_finalize_document", "legal_precedent_search", "legal_precedent_read", "legal_validate_draft"]) assert.ok(names.has(name), name);
	for (const name of ["legal_read_document_set", "legal_build_clause_inventory", "legal_audit_commercial_coverage", "legal_validate_review_findings", "legal_render_review_report"]) assert.ok(!names.has(name), name);
	assert.ok(!names.has("reviewer_perera_start_review"));
	assert.ok(!names.has("drafter_weeramantry_draft_or_revise"));
});
