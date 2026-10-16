import { inputFile, operationDirectory, saveJson } from "../core/files.mjs";
import { preparePreview } from "../core/previews.mjs";

// This is intentionally an optional presentation tool. It does not alter the
// original deliverable and never uploads the document to a third party.
export async function prepareDocumentPreview(args, { onProgress = () => {} } = {}) {
	if (!args.file_path) throw new Error("file_path is required");
	onProgress("Preparing a local LibreChat preview of the document…");
	const source = await inputFile(args.file_path);
	const operation = await operationDirectory("preview");
	const preview = await preparePreview(source.absolute, args.title);
	await saveJson(operation.directory, "preview-manifest.json", {
		source: source.name,
		kind: preview.kind,
		title: preview.title,
		created_at: new Date().toISOString(),
	});
	return {
		operation_id: operation.id,
		source_file: source.absolute,
		preview_kind: preview.kind,
		preview_title: preview.title,
		artifact_markup: preview.markup,
		delivery_instruction: "The original downloadable file remains unchanged. The artifact_markup is the user-visible LibreChat preview for this completed deliverable; include it with the final delivery after the preview tool is called.",
	};
}
