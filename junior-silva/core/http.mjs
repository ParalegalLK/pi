export async function requestJson(url, init, label, timeoutMs = 1_200_000) {
	let response;
	try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
	catch (error) { throw new Error(`${label} could not connect: ${error instanceof Error ? error.message : String(error)}`); }
	const text = await response.text();
	if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${text.slice(0, 2_000)}`);
	try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON`); }
}

export async function requestCompletion(url, init, label, timeoutMs = 1_200_000, onProgress = () => {}) {
	let response;
	try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
	catch (error) { throw new Error(`${label} could not connect: ${error instanceof Error ? error.message : String(error)}`); }
	if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("text/event-stream")) {
		const text = await response.text();
		try {
			const value = JSON.parse(text);
			const reasoning = value.choices?.[0]?.message?.reasoning_content ?? value.choices?.[0]?.delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.trim()) onProgress(reasoning.trim());
			return value.choices?.[0]?.message?.content ?? value.choices?.[0]?.delta?.content ?? text;
		}
		catch { return text; }
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const pieces = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			try {
				const delta = JSON.parse(payload).choices?.[0]?.delta || {};
				if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim()) onProgress(delta.reasoning_content.trim());
				if (typeof delta.content === "string") pieces.push(delta.content);
			}
			catch { /* Ignore service progress frames. */ }
		}
	}
	return pieces.join("");
}

export async function download(url, label, maximumBytes = 50 * 1024 * 1024) {
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") || "0");
	if (declared > maximumBytes) throw new Error(`${label} exceeds the download limit`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds the download limit`);
	return bytes;
}
