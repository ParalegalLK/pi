import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "junior-silva-chat-folders-"));
process.env.JUNIOR_SILVA_DATA_ROOT = dataRoot;
process.env.JUNIOR_SILVA_ARTIFACT_ROOT = path.join(dataRoot, "artifacts");
process.env.JUNIOR_SILVA_UPLOAD_ROOT = path.join(dataRoot, "uploads");
process.env.JUNIOR_SILVA_WORKSPACE_ROOT = path.join(dataRoot, "workspace");
process.env.JUNIOR_SILVA_PUBLIC_URL = "https://example.test";
process.env.JUNIOR_SILVA_API_KEY ||= "test-junior-silva-key";

const { chatFolders, createChatFolders, insideChatWorkspace } = await import("../core/chat-scope.mjs");
const { publishWorkspaceArtifact } = await import("../core/files.mjs");
const { agentEnvironment } = await import("../server/openai.mjs");

test.after(() => rm(dataRoot, { recursive: true, force: true }));

const USER = "a".repeat(32);
const OTHER_USER = "b".repeat(32);
const CHAT = "c".repeat(32);
const OTHER_CHAT = "d".repeat(32);
const scope = { userHash: USER, chatHash: CHAT };

test("a chat's folders all sit under its user and chat hashes", () => {
	const root = path.join(dataRoot, "users", USER, "chats", CHAT);
	assert.deepEqual(chatFolders(scope), {
		root,
		uploads: path.join(root, "uploads"),
		workspace: path.join(root, "workspace"),
		sessions: path.join(root, "sessions"),
	});
});

test("different users and different chats get different folders", () => {
	const roots = new Set([
		chatFolders(scope).root,
		chatFolders({ userHash: OTHER_USER, chatHash: CHAT }).root,
		chatFolders({ userHash: USER, chatHash: OTHER_CHAT }).root,
	]);
	assert.equal(roots.size, 3);
});

test("creating a chat's folders makes them private and keeps what's already there", async () => {
	const folders = await createChatFolders({ userHash: USER, chatHash: "e".repeat(32) });
	for (const directory of [folders.root, folders.uploads, folders.workspace, folders.sessions, path.join(dataRoot, "users", USER)]) {
		assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
	}
	const kept = path.join(folders.sessions, "session.jsonl");
	await writeFile(kept, "history");
	await createChatFolders({ userHash: USER, chatHash: "e".repeat(32) });
	assert.equal(await readFile(kept, "utf8"), "history");
});

test("insideChatWorkspace accepts only files in a chat's workspace", () => {
	const { root, uploads, workspace, sessions } = chatFolders(scope);
	assert.equal(insideChatWorkspace(path.join(workspace, "draft.docx")), true);
	assert.equal(insideChatWorkspace(path.join(workspace, "requests", "r1", "nested", "draft.docx")), true);

	const refused = [
		workspace,
		path.join(uploads, "contract.pdf"),
		path.join(sessions, "session.jsonl"),
		path.join(root, "draft.docx"),
		`${workspace}/../uploads/contract.pdf`,
		`${workspace}/../../../../${OTHER_USER}/chats/${CHAT}/uploads/contract.pdf`,
		path.join(dataRoot, "users", "abc", "chats", CHAT, "workspace", "draft.docx"),
		path.join(dataRoot, "users", USER, "chats", "abc", "workspace", "draft.docx"),
		path.join(dataRoot, "users", USER.toUpperCase(), "chats", CHAT, "workspace", "draft.docx"),
		path.join(dataRoot, "workspace", "draft.docx"),
		"/etc/passwd",
	];
	for (const file of refused) assert.equal(insideChatWorkspace(file), false, file);
});

test("Pi's session and upload settings point at this chat", () => {
	const folders = chatFolders(scope);
	const requestWorkspace = path.join(folders.workspace, "requests", "r1");
	const output = agentEnvironment(folders, requestWorkspace);
	assert.equal(output.PI_CODING_AGENT_SESSION_DIR, folders.sessions);
	assert.equal(output.JUNIOR_SILVA_UPLOAD_ROOT, folders.uploads);
	assert.equal(output.JUNIOR_SILVA_WORKSPACE_ROOT, requestWorkspace);
});

test("a file in a chat's workspace publishes, and a file in its other folders doesn't", async () => {
	const folders = await createChatFolders({ userHash: USER, chatHash: "f".repeat(32) });
	const requestWorkspace = path.join(folders.workspace, "requests", "r1");
	await mkdir(requestWorkspace, { recursive: true });
	const draft = path.join(requestWorkspace, "note.md");
	await writeFile(draft, "# Test note\n\nA short test note.\n");

	const publication = await publishWorkspaceArtifact(draft);
	assert.match(publication.artifact.download_url, /^https:\/\/example\.test\/files\//);

	for (const directory of [folders.uploads, folders.sessions]) {
		const file = path.join(directory, "note.md");
		await writeFile(file, "# Test note\n");
		await assert.rejects(publishWorkspaceArtifact(file), /Only files created in Junior Silva's workspace can be published/);
	}
});
