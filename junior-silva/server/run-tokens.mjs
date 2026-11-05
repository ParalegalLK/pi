import { randomBytes } from "node:crypto";

const tokens = new Map();

// A run token ties one Pi run to one chat. Pi sends it with every tool call, so
// the bridge knows which chat the call is for. Tokens live only in this process.
export function createRunToken(chat, lifetimeMs) {
	const token = randomBytes(32).toString("hex");
	tokens.set(token, { chat, expiresAt: Date.now() + lifetimeMs });
	return token;
}

export function chatForRunToken(token) {
	const entry = tokens.get(token);
	if (!entry) return undefined;
	if (Date.now() >= entry.expiresAt) {
		tokens.delete(token);
		return undefined;
	}
	return entry.chat;
}

export function revokeRunToken(token) {
	tokens.delete(token);
}
