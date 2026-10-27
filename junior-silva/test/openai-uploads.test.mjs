import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const uploadRoot = await mkdtemp(path.join(os.tmpdir(), "junior-silva-uploads-"));
process.env.JUNIOR_SILVA_UPLOAD_ROOT = uploadRoot;
process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";

const { conversationUploadPaths, fileCandidates, piPrompt, saveUploads, textUploads } = await import("../server/openai.mjs");

test.after(async () => rm(uploadRoot, { recursive: true, force: true }));

test("only current-turn attachment candidates are passed through", () => {
	const body = {
		messages: [
			{ role: "user", files: [{ file_id: "old", url: "data:text/plain;base64,b2xk", filename: "old.txt" }] },
			{ role: "assistant", content: "Earlier reply" },
			{ role: "user", files: [{ file_id: "new", url: "data:text/plain;base64,bmV3", filename: "new.txt" }] },
		],
	};
	assert.deepEqual(fileCandidates(body), [{ sourceId: "new", url: "data:text/plain;base64,bmV3", name: "new.txt" }]);
});

test("historical Upload as Text content is not reintroduced on a follow-up", () => {
	const envelope = 'Attached document(s):\n```markdown\n# "agreement.md"\nSource text\n```\nReview this';
	assert.deepEqual(textUploads([{ role: "user", content: envelope }, { role: "assistant", content: "I have read it." }, { role: "user", content: "What is the main risk?" }]), {
		instruction: "What is the main risk?",
		files: [],
	});
});

test("identical uploads are stored once and supplied only on their first turn", async () => {
	const candidate = { sourceId: "libre-file-1", name: "agreement.txt", url: "data:text/plain;base64,YWdyZWVtZW50" };
	const first = await saveUploads("conversation-test", [candidate], []);
	const second = await saveUploads("conversation-test", [candidate], []);
	assert.equal(first.length, 1);
	assert.deepEqual(second, []);
	assert.deepEqual(await conversationUploadPaths("conversation-test"), first);
	assert.match(piPrompt("What is the risk?", [], "/request"), /Documents supplied in earlier turns remain available/);
	const entries = await readdir(path.join(uploadRoot, "conversation-test"));
	assert.equal(entries.filter((entry) => !entry.startsWith(".")).length, 1);
});

test("same filename with new bytes remains a distinct conversation document", async () => {
	const first = await saveUploads("changed-file-test", [{ sourceId: "file-one", name: "agreement.pdf", url: "data:text/plain;base64,b2xk" }], []);
	const second = await saveUploads("changed-file-test", [{ sourceId: "file-two", name: "agreement.pdf", url: "data:text/plain;base64,bmV3" }], []);
	assert.equal(first.length, 1);
	assert.equal(second.length, 1);
	assert.notEqual(first[0], second[0]);
});
