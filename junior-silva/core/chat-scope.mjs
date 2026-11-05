import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { artifactsRoot, booleanEnv, dataRoot, requiredEnv, uploadsRoot, workspaceRoot } from "./environment.mjs";

const USERS_ROOT = path.join(dataRoot, "users");
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FILE_NOT_FOUND = "File not found in this chat.";
const activeChat = new AsyncLocalStorage();
const USER_ID = /^[a-f0-9]{24}$/;
const CHAT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const PLACEHOLDER_CHAT_IDS = new Set(["new", "null", "undefined", "PENDING"]);

// Fixed text only: LibreChat shows these messages to the user word for word.
function rejected(message) {
	return Object.assign(new Error(message), { status: 400 });
}

function keyedHash(...parts) {
	return createHmac("sha256", requiredEnv("JS_IDENTITY_SECRET")).update(parts.join("\0")).digest("hex").slice(0, 32);
}

// Works out which user and chat a request belongs to. There are no fallbacks: a
// request without real IDs is refused, so it can't land in a shared folder. The
// chat hash includes the user ID, because a crafted request can choose its chat ID.
export function resolveChatScope(headers, body) {
	const userId = String(headers["x-librechat-user-id"] ?? "");
	const chatId = String(headers["x-librechat-conversation-id"] ?? "");
	if (!USER_ID.test(userId)) throw rejected("This request has no valid user ID.");
	if (!CHAT_ID.test(chatId) || PLACEHOLDER_CHAT_IDS.has(chatId)) throw rejected("This request has no valid chat ID.");
	if (body.user != null && body.user !== userId) throw rejected("The user in this request doesn't match its user ID.");
	return { userHash: keyedHash("user", userId), chatHash: keyedHash("chat", userId, chatId) };
}

// Everything about a chat sits under one folder, so a sandbox can later be given
// that chat and nothing else.
export function chatFolders({ userHash, chatHash }) {
	const root = path.join(USERS_ROOT, userHash, "chats", chatHash);
	return { root, uploads: path.join(root, "uploads"), workspace: path.join(root, "workspace"), sessions: path.join(root, "sessions") };
}

export async function createChatFolders(scope) {
	const folders = chatFolders(scope);
	await Promise.all([folders.uploads, folders.workspace, folders.sessions].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
	return folders;
}

// Runs a tool call for one chat. Tools read the chat with currentChat(), so they
// don't need a chat argument, and two calls at once can't see each other's chat.
export function runInChat(chat, task) {
	return activeChat.run(chat, task);
}

// A chat comes from runInChat, or from an explicit native CLI setting on one
// developer's machine. Anything else is an error, never a shared folder.
export function currentChat() {
	const chat = activeChat.getStore();
	if (chat) return chat;
	if (booleanEnv("JS_NATIVE_DEV")) return { native: true, folders: { uploads: uploadsRoot, workspace: workspaceRoot } };
	throw new Error("This tool can only run for a chat, and none is set.");
}

function inside(file, roots) {
	return roots.some((root) => file.startsWith(`${root}${path.sep}`));
}

// Never sessions. Artifacts stay shared between chats until they move per chat.
async function allowedRoots(chat, only = ["uploads", "workspace", "artifacts"]) {
	const folders = { uploads: chat.folders.uploads, workspace: chat.folders.workspace, artifacts: chat.folders.artifacts ?? artifactsRoot };
	const roots = await Promise.all(only.map((name) => realpath(folders[name]).catch(() => undefined)));
	return roots.filter(Boolean);
}

// The one way a tool opens a file named by Pi. Pi controls the path and can change
// the file at any moment, so this checks the real path, then what was really
// opened, and reads only from that handle. Every path failure gives the same
// message, so Pi can't use errors to find out what exists in another chat.
async function openChatFile(filename, { only, flags = constants.O_RDONLY } = {}) {
	const chat = currentChat();
	const absolute = path.resolve(String(filename));
	const name = path.basename(absolute);
	const refuse = (reason) => {
		console.warn(`[junior-silva-v2] Refused a file for chat ${chat.chatHash ?? "native"}: ${reason}`);
		return Object.assign(new Error(FILE_NOT_FOUND), { refused: true });
	};
	let handle;
	try {
		// The native CLI is one developer on their own machine, so normal reads can open any path.
		const roots = chat.native && !only ? undefined : await allowedRoots(chat, only);
		const real = await realpath(absolute);
		if (roots && !inside(real, roots)) throw refuse("outside its folders");
		// O_NONBLOCK: opening a FIFO must not hang the bridge.
		handle = await open(real, flags | constants.O_NONBLOCK);
		// Pi could swap the file for a symlink after the check above.
		if (!chat.native && !inside(await readlink(`/proc/self/fd/${handle.fd}`), roots)) throw refuse("it changed while opening");
		const info = await handle.stat();
		if (!info.isFile()) throw refuse("not a regular file");
		if (info.size > MAX_FILE_BYTES) throw Object.assign(new Error(`${name} exceeds the 50 MB input limit`), { refused: true });
		const bytes = Buffer.alloc(info.size);
		const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
		return { handle, absolute, name, bytes: bytes.subarray(0, bytesRead) };
	} catch (caught) {
		await handle?.close();
		throw caught?.refused ? caught : new Error(FILE_NOT_FOUND);
	}
}

export async function readChatFile(filename, options) {
	const { handle, ...file } = await openChatFile(filename, options);
	await handle.close();
	return file;
}

export async function readChatText(filename, options) {
	return (await readChatFile(filename, options)).bytes.toString("utf8");
}

// Reads and rewrites through one handle, so a swap can't redirect the write.
export async function updateChatFile(filename, change, options) {
	const { handle, bytes } = await openChatFile(filename, { ...options, flags: constants.O_RDWR });
	try {
		const updated = await change(bytes.toString("utf8"));
		await handle.truncate(0);
		await handle.write(updated, 0, "utf8");
	} finally {
		await handle.close();
	}
}
