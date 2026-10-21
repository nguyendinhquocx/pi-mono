import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const MARKER = "TERMINAL_COLOR_QUERY=";
const PATCHED_FORM = "TERMINAL_COLOR_QUERY=``";
const TERMINATOR = "\\x1B[c`";
const MAX_SPAN = 1000;

function sha256Short(data) {
	return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

function collectBundleJavaScript(directory, files) {
	for (const name of readdirSync(directory).sort()) {
		if (name.endsWith(".map")) continue;
		const fullPath = join(directory, name);
		const stats = statSync(fullPath);
		if (stats.isDirectory()) collectBundleJavaScript(fullPath, files);
		else if (name.endsWith(".js")) files.push(fullPath);
	}
}

/**
 * Neutralize terminal color-query replies in the Li CLI bundle before the CLI can load them.
 * The shared runtime extension still guards Pi's npm dist; Li should not need a runtime rewrite.
 */
export function neutralizeLiTerminalColorQuery(bundleDir) {
	const files = [];
	collectBundleJavaScript(bundleDir, files);
	const changedFiles = [];
	let markerCount = 0;
	let patchedMarkerCount = 0;

	for (const file of files) {
		const original = readFileSync(file, "utf8");
		let source = original;
		let cursor = 0;
		let changed = false;
		let fileMarkerCount = 0;

		while (true) {
			const start = source.indexOf(MARKER, cursor);
			if (start === -1) break;
			markerCount++;
			fileMarkerCount++;

			if (source.startsWith(PATCHED_FORM, start)) {
				patchedMarkerCount++;
				cursor = start + PATCHED_FORM.length;
				continue;
			}

			const templateStart = MARKER + String.fromCharCode(96);
			if (!source.startsWith(templateStart, start)) {
				throw new Error(`Unexpected TERMINAL_COLOR_QUERY assignment in ${file}`);
			}

			const bodyStart = start + MARKER.length + 1;
			const end = source.indexOf(TERMINATOR, bodyStart);
			if (end === -1 || end - start > MAX_SPAN) {
				throw new Error(`Could not recognize TERMINAL_COLOR_QUERY template in ${file}`);
			}

			source = source.slice(0, start) + PATCHED_FORM + source.slice(end + TERMINATOR.length);
			changed = true;
			cursor = start + PATCHED_FORM.length;
		}

		if (changed) {
			writeFileSync(file, source, "utf8");
			changedFiles.push({
				file: relative(bundleDir, file).replaceAll("\\", "/"),
				beforeSha: sha256Short(original),
				afterSha: sha256Short(source),
				markerCount: fileMarkerCount,
			});
		}
	}

	return {
		status: markerCount === 0 ? "not-present" : changedFiles.length > 0 ? "patched" : "already-patched",
		markerCount,
		patchedMarkerCount,
		files: changedFiles,
	};
}
