import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { booleanEnv, dataRoot, requiredEnv, uploadsRoot, workspaceRoot } from "./environment.mjs";

const USERS_ROOT = path.join(dataRoot, "users");
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

// True for a file inside any chat's workspace. It doesn't check which chat, or
// follow symlinks: the chat context and path guard add that.
export function insideChatWorkspace(file) {
	const relative = path.relative(USERS_ROOT, path.resolve(file)).split(path.sep).join("/");
	return /^[a-f0-9]{32}\/chats\/[a-f0-9]{32}\/workspace\/./.test(relative);
}
