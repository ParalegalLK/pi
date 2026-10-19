const SENSITIVE_FILE_PATTERN = /(?:^|[\\/])\.env(?:\.[^\\/]+)?$|(?:^|[\\/])(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519)(?:\.[^\\/]*)?$|\.(?:pem|key|p12|pfx)$/i;
const SENSITIVE_DIRECTORY_PATTERN = /(?:^|[\\/])\.(?:ssh|aws|gnupg)(?:[\\/]|$)|(?:^|[\\/])proc(?:[\\/]|$)/i;
const EXFILTRATION_PATTERN = /\b(?:show|reveal|give|list|print|read|dump|extract|export|display|send|copy|cat|type|get-content)\b/i;
const PRIVATE_CONTEXT_PATTERN = /(?:\.env\b|api[ _-]?key|access[ _-]?token|secret(?:s)?\b|credential(?:s)?\b|private prompt|system prompt|internal (?:architecture|config(?:uration)?|service|address|network)|container detail|source code)/i;
const BYPASS_PATTERN = /\b(?:ignore|bypass|override|disable|evade)\b.{0,80}\b(?:guardrail|safety|security|system (?:prompt|rule)|restriction|policy|instruction)s?\b/i;

function normaliseText(value) {
	return String(value || "").trim();
}

export function findSensitiveUserRequest(text) {
	const value = normaliseText(text);
	if (!value) return null;
	if (BYPASS_PATTERN.test(value)) return "I can’t help bypass system safeguards or disclose protected service information.";
	if (EXFILTRATION_PATTERN.test(value) && PRIVATE_CONTEXT_PATTERN.test(value)) {
		return "I can’t provide private system information, credentials, prompts, configuration, or source code.";
	}
	return null;
}

export function isSensitivePath(value) {
	const path = normaliseText(value).replace(/\\+/g, "/");
	return Boolean(path && (SENSITIVE_FILE_PATTERN.test(path) || SENSITIVE_DIRECTORY_PATTERN.test(path)));
}

export function toolSafetyReason(toolName, input) {
	const name = normaliseText(toolName).toLowerCase();
	const serialized = JSON.stringify(input || {});
	const hasSensitiveReference = isSensitivePath(serialized)
		|| /(?:^|["'\s])(?:[^"'\s]*[\\/])?\.env(?:\.[^"'\s]+)?(?=$|["'\s,}])|(?:\.ssh|\.aws|\.gnupg)(?:[\\/]|["'])|\b(?:id_rsa|id_ed25519)\b|\.(?:pem|key|p12|pfx)(?=$|["'\s,}])/i.test(serialized);
	if (["read", "edit", "write", "grep", "find", "ls"].includes(name) && hasSensitiveReference) {
		return "Access to protected credentials and service configuration is blocked.";
	}
	if (["bash", "powershell"].includes(name)) {
		const environmentRead = name === "powershell"
			? /\b(?:dir|get-childitem|get-item)\s+env:|\$env:/i.test(serialized)
			: /(?:^|[;&|]\s*)(?:printenv|env)(?:\s|$)|(?:^|[;&|]\s*)set\s+(?:-[a-z]+\s*)?$/im.test(serialized);
		if (environmentRead) {
			return "Reading process environment variables is blocked.";
		}
		if (hasSensitiveReference || /(?:get-content|cat|type|copy-item|cp)\b[^\n]*(?:\.env\b|credentials?|secrets?|\.ssh|\.aws|\.gnupg|id_rsa|\.pem\b|\.key\b)/i.test(serialized)) {
			return "Access to protected credentials and service configuration is blocked.";
		}
	}
	return null;
}
