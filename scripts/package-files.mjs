// Cross-platform file operations for package build scripts, using only Node built-ins.
import { chmodSync, cpSync, existsSync, globSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const [command, ...paths] = process.argv.slice(2);
const usage = "Usage: package-files.mjs clean [--force] <paths...> | copy <sources...> <directory> | executable <files...>";

if (paths.length === 0) throw new Error(usage);

switch (command) {
	case "clean": {
		const force = paths.includes("--force");
		const targets = paths.filter((path) => path !== "--force");
		if (targets.length === 0) throw new Error(usage);
		for (const path of targets) cleanBuildOutput(path, force);
		break;
	}
	case "copy": {
		const destination = paths.pop();
		if (!destination || paths.length === 0) throw new Error(usage);
		mkdirSync(destination, { recursive: true });
		for (const pattern of paths) {
			const sources = globSync(pattern);
			if (sources.length === 0) throw new Error(`No files match ${pattern}`);
			for (const source of sources) cpSync(source, join(destination, basename(source)), { recursive: true });
		}
		break;
	}
	case "executable":
		for (const path of paths) chmodSync(path, statSync(path).mode | 0o111);
		break;
	default:
		throw new Error(usage);
}

// Nearest ancestor (starting at the target itself) that holds a package.json.
function findPackageRoot(fromPath) {
	let current = fromPath;
	while (true) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function isWithin(parentPath, childPath) {
	const rel = relative(parentPath, childPath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// `clean` may only delete build output inside <package>/dist or <package>/.eval.
// Missing targets stay an idempotent no-op; junction/symlink escapes are
// refused even with --force; everything else is overridable with --force.
function cleanBuildOutput(rawPath, force) {
	const target = resolve(rawPath);
	if (!existsSync(target)) return;
	const real = realpathSync(target);
	// Windows is case-insensitive: compare folded so a canonical-cased realpath
	// (different drive/dir casing only) is not mistaken for a junction escape.
	const samePath = process.platform === "win32" ? real.toLowerCase() === target.toLowerCase() : real === target;
	if (!samePath) {
		throw new Error(
			`Refusing to clean "${rawPath}": junction/symlink escape (resolves to ${real}). Not overridable with --force.`,
		);
	}
	const refusals = cleanRefusalReasons(target);
	if (refusals.length > 0) {
		if (!force) throw new Error(`Refusing to clean "${rawPath}": ${refusals.join("; ")}`);
		console.log(`[package-files] --force clean of out-of-boundary target: ${target}`);
	}
	rmSync(target, { recursive: true, force: true });
}

function cleanRefusalReasons(target) {
	const reasons = [];
	const segments = target.split(/[\\/]/).map((segment) => segment.toLowerCase());
	if (target === repoRoot) reasons.push("target is the repository root");
	if (segments.includes(".git")) reasons.push("path contains a .git segment");
	if (isWithin(target, resolve())) reasons.push("target contains the current working directory");
	const packageRoot = findPackageRoot(target);
	if (!packageRoot) {
		reasons.push("no package.json ancestor to define a build-output boundary");
		return reasons;
	}
	const boundaries = [join(packageRoot, "dist"), join(packageRoot, ".eval")];
	if (!boundaries.some((boundary) => isWithin(boundary, target))) {
		reasons.push(
			`target is outside the package build-output boundary (allowed: <package>/dist, <package>/.eval); package root: ${packageRoot}`,
		);
	}
	return reasons;
}
