// @ts-nocheck
import { readdirSync, readFileSync } from 'node:fs';

const MARKER = '<!-- drizzle-check -->';

const env = process.env;

function notice(message) {
	process.stdout.write(`::notice::${message}\n`);
}

function readEvent() {
	const path = env.GITHUB_EVENT_PATH;
	if (!path) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

function resolvePrNumber(event) {
	if (!event) return null;
	return event.pull_request?.number ?? event.issue?.number ?? null;
}

function parseEnvelope(raw) {
	if (!raw) return null;
	const lines = raw
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('{') && line.endsWith('}'));
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]);
		} catch {
			continue;
		}
	}
	return null;
}

function renderClean(envelope) {
	const dialect = envelope.dialect ?? 'your migrations';
	return `### ✅ No migration conflicts\n\n`
		+ `\`drizzle-kit check\` found no conflicting migrations for \`${dialect}\`.`;
}

const ACTION_VERBS = {
	create: 'creates',
	drop: 'drops',
	alter: 'alters',
	recreate: 'recreates',
	rename: 'renames',
	move: 'moves',
	add: 'adds',
	remove: 'removes',
	delete: 'deletes',
};

const SPECIAL_ACTIONS = {
	alter_type_drop_value: 'removes a value from enum',
};

function humanizeAction(action) {
	if (action in SPECIAL_ACTIONS) return SPECIAL_ACTIONS[action];
	const [verb, ...rest] = action.split('_');
	const conjugated = ACTION_VERBS[verb];
	if (!conjugated) return action.replace(/_/g, ' ');
	return rest.length ? `${conjugated} ${rest.join(' ')}` : conjugated;
}

// statementDescription formats produced by the dialects' describeStatement():
//   "<action>: <name> on <table> table"
//   "<action>: <object> in <schema> schema"
//   "<action>: <schema> schema"
//   "<action> on <object> table"
function humanizeDescription(raw) {
	if (typeof raw !== 'string' || raw.length === 0) return raw ?? '';
	let m = raw.match(/^([a-z0-9_]+): (.+) on (.+) table$/);
	if (m) return `${humanizeAction(m[1])} \`${m[2]}\` on table \`${m[3]}\``;
	m = raw.match(/^([a-z0-9_]+): (.+) in (.+) schema$/);
	if (m) return `${humanizeAction(m[1])} \`${m[2]}\` in schema \`${m[3]}\``;
	m = raw.match(/^([a-z0-9_]+): (.+) schema$/);
	if (m) return `${humanizeAction(m[1])} \`${m[2]}\``;
	m = raw.match(/^([a-z0-9_]+): (.+)$/);
	if (m) return `${humanizeAction(m[1])} \`${m[2]}\``;
	m = raw.match(/^([a-z0-9_]+) on (.+) table$/);
	if (m) return `${humanizeAction(m[1])} on table \`${m[2]}\``;
	return raw;
}

function normalizedWd() {
	return (env.DRIZZLE_WORKING_DIRECTORY || '.').replace(/^\.\/?/, '').replace(/\/+$/, '');
}

// Links a migration folder at the commit the check ran against (the PR merge commit),
// so every listed migration — including ones coming from the base branch — resolves.
function migrationLink(path) {
	const repo = env.GITHUB_REPOSITORY;
	const sha = env.GITHUB_SHA;
	if (!path || !repo || !sha) return `\`${path}\``;
	const server = env.GITHUB_SERVER_URL || 'https://github.com';
	const wd = normalizedWd();
	const fullPath = wd ? `${wd}/${path}` : path;
	return `[\`${path}\`](${server}/${repo}/tree/${sha}/${fullPath})`;
}

async function fetchPrFiles(repo, prNumber, token) {
	const files = [];
	let page = 1;
	while (true) {
		const response = await gh(
			'GET',
			`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
			token,
		);
		const batch = await response.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		files.push(...batch);
		if (batch.length < 100) break;
		page++;
	}
	return files;
}

// Classifies the conflict's migrations: folders added by this PR belong to the
// current branch; everything else is already on the base branch.
function buildBranchContext(error, files, event) {
	const details = Array.isArray(error.details) ? error.details : [];
	const outDirs = new Set();
	for (const conflict of details) {
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			if (typeof branch.leafPath === 'string' && branch.leafPath.includes('/')) {
				outDirs.add(branch.leafPath.split('/')[0]);
			}
		}
	}
	if (outDirs.size === 0) return null;

	const wd = normalizedWd();
	const wdPrefix = wd ? `${wd}/` : '';
	const ownedFolders = new Set();
	for (const file of files) {
		if (file.status !== 'added' || typeof file.filename !== 'string') continue;
		if (!file.filename.startsWith(wdPrefix)) continue;
		const rel = file.filename.slice(wdPrefix.length);
		const segments = rel.split('/');
		if (segments.length < 3 || !outDirs.has(segments[0])) continue;
		ownedFolders.add(`${segments[0]}/${segments[1]}`);
	}

	return {
		ownedFolders: [...ownedFolders].sort(),
		baseRef: event?.pull_request?.base?.ref ?? null,
	};
}

function outDirsFromDetails(error) {
	const dirs = new Set();
	for (const conflict of Array.isArray(error.details) ? error.details : []) {
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			if (typeof branch.leafPath === 'string' && branch.leafPath.includes('/')) {
				dirs.add(branch.leafPath.split('/')[0]);
			}
		}
		if (typeof conflict.parentPath === 'string' && conflict.parentPath.includes('/')) {
			dirs.add(conflict.parentPath.split('/')[0]);
		}
	}
	return [...dirs];
}

// The comment step runs inside the workflow's checkout, so the full migration DAG
// can be read from the snapshots instead of relying on the envelope's flat list.
function readMigrationDag(outDirs) {
	const nodes = new Map();
	const byFolder = new Map();
	for (const dir of outDirs) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const folder = `${dir}/${entry.name}`;
			try {
				const snapshot = JSON.parse(readFileSync(`${folder}/snapshot.json`, 'utf8'));
				if (typeof snapshot?.id !== 'string') continue;
				const node = {
					id: snapshot.id,
					folder,
					prevIds: Array.isArray(snapshot.prevIds) ? snapshot.prevIds : [],
				};
				nodes.set(node.id, node);
				byFolder.set(folder, node);
			} catch {
				continue;
			}
		}
	}
	return nodes.size > 0 ? { nodes, byFolder } : null;
}

// Extracts the part of the DAG involved in the conflict: the fork parents, the
// conflicting leaves, and the chain nodes connecting them.
function conflictNeighborhood(error, dag) {
	const details = Array.isArray(error.details) ? error.details : [];
	const parentIds = new Set();
	const conflictIds = new Set();
	const included = new Map();

	for (const conflict of details) {
		const parent = conflict.parentPath ? dag.byFolder.get(conflict.parentPath) : null;
		if (!parent) return null;
		parentIds.add(parent.id);
		included.set(parent.id, parent);
	}

	for (const conflict of details) {
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			const leaf = branch.leafPath ? dag.byFolder.get(branch.leafPath) : null;
			if (!leaf) return null;
			conflictIds.add(leaf.id);
			const queue = [leaf];
			let guard = 0;
			while (queue.length > 0) {
				if (guard++ > 200) return null;
				const node = queue.pop();
				if (included.has(node.id)) continue;
				included.set(node.id, node);
				for (const prevId of node.prevIds) {
					const prev = dag.nodes.get(prevId);
					if (prev && !included.has(prev.id)) queue.push(prev);
				}
			}
		}
	}

	const edges = [];
	for (const node of included.values()) {
		for (const prevId of node.prevIds) {
			if (included.has(prevId)) edges.push([prevId, node.id]);
		}
	}

	return { nodes: [...included.values()], edges, conflictIds, parentIds };
}

function shortName(folder) {
	return folder.split('/').pop().replace(/^\d+_/, '');
}

function descriptionsByLeaf(error) {
	const map = new Map();
	for (const conflict of Array.isArray(error.details) ? error.details : []) {
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			if (!branch.leafPath) continue;
			if (!map.has(branch.leafPath)) map.set(branch.leafPath, new Set());
			map.get(branch.leafPath).add(humanizeDescription(branch.statementDescription ?? ''));
		}
	}
	return map;
}

function renderMermaid(neighborhood, ctx) {
	const ownedSet = new Set(ctx?.ownedFolders ?? []);
	const idMap = new Map();
	neighborhood.nodes.forEach((node, i) => idMap.set(node.id, `m${i}`));

	const declare = (node) => `    ${idMap.get(node.id)}["${shortName(node.folder)}"]`;
	const owned = neighborhood.nodes.filter((node) => ownedSet.has(node.folder));
	const rest = neighborhood.nodes.filter((node) => !ownedSet.has(node.folder));

	const lines = ['```mermaid', 'flowchart TD'];
	for (const node of rest) lines.push(declare(node));
	if (owned.length > 0) {
		lines.push('    subgraph thisbranch["this branch"]');
		for (const node of owned) lines.push(`    ${declare(node)}`);
		lines.push('    end');
	}
	for (const [from, to] of neighborhood.edges) {
		lines.push(`    ${idMap.get(from)} --> ${idMap.get(to)}`);
	}
	const conflictNodes = neighborhood.nodes
		.filter((node) => neighborhood.conflictIds.has(node.id))
		.map((node) => idMap.get(node.id));
	if (conflictNodes.length > 0) {
		lines.push('    classDef conflict fill:#ffd7d5,stroke:#cf222e');
		lines.push(`    class ${conflictNodes.join(',')} conflict`);
	}
	lines.push('```');
	return lines;
}

function renderDiffTree(error, ctx) {
	const details = Array.isArray(error.details) ? error.details : [];
	const descriptions = descriptionsByLeaf(error);
	const baseLabel = ctx?.baseRef ? `from ${ctx.baseRef}` : 'from the base branch';
	const ownedSet = new Set(ctx?.ownedFolders ?? []);
	const origin = (leafPath) => {
		if (!ctx) return '';
		return ownedSet.has(leafPath) ? ' (this branch)' : ` (${baseLabel})`;
	};

	const byParent = new Map();
	for (const conflict of details) {
		const parent = conflict.parentPath ?? conflict.parentId ?? '(unknown parent)';
		if (!byParent.has(parent)) byParent.set(parent, new Set());
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			byParent.get(parent).add(branch.leafPath ?? branch.leafId ?? '(unknown migration)');
		}
	}

	const lines = ['```diff'];
	let first = true;
	for (const [parent, leaves] of byParent) {
		if (!first) lines.push('');
		first = false;
		lines.push(`  ${parent}`);
		const list = [...leaves];
		list.forEach((leaf, i) => {
			const connector = i === list.length - 1 ? '└──' : '├──';
			const descs = [...descriptions.get(leaf) ?? []].join('; ');
			lines.push(`- ${connector} ${leaf}${origin(leaf)}${descs ? `  ⚠ ${descs}` : ''}`);
		});
	}
	lines.push('```');
	return lines;
}

function renderNestedList(error, ctx, neighborhood) {
	if (!neighborhood) return renderLinkedList(error, ctx);

	const descriptions = descriptionsByLeaf(error);
	const baseLabel = ctx?.baseRef ? `from \`${ctx.baseRef}\`` : 'from the base branch';
	const ownedSet = new Set(ctx?.ownedFolders ?? []);
	const origin = (folder) => {
		if (!ctx) return '';
		return ownedSet.has(folder) ? ' *(this branch)*' : ` *(${baseLabel})*`;
	};

	const byId = new Map(neighborhood.nodes.map((node) => [node.id, node]));
	const children = new Map();
	for (const [from, to] of neighborhood.edges) {
		if (!children.has(from)) children.set(from, []);
		children.get(from).push(to);
	}

	const parents = neighborhood.nodes.filter((node) => neighborhood.parentIds.has(node.id));
	const forkPoint = parents.map((node) => migrationLink(node.folder)).join(' + ');
	const lines = [`- 🔀 ${forkPoint} *(fork point)*`];

	const renderNode = (id, depth, visited) => {
		if (visited.has(id)) return;
		visited.add(id);
		const node = byId.get(id);
		const isConflict = neighborhood.conflictIds.has(id);
		const emoji = isConflict ? '🔴' : '⚪';
		const descs = isConflict ? [...descriptions.get(node.folder) ?? []].join('; ') : '';
		lines.push(
			`${'  '.repeat(depth)}- ${emoji} ${migrationLink(node.folder)}${origin(node.folder)}${
				descs ? ` — ${descs}` : ''
			}`,
		);
		for (const childId of children.get(id) ?? []) renderNode(childId, depth + 1, visited);
	};

	const visited = new Set();
	const topLevel = new Set();
	for (const parent of parents) {
		for (const childId of children.get(parent.id) ?? []) topLevel.add(childId);
	}
	for (const id of topLevel) renderNode(id, 1, visited);

	return lines;
}

function renderLinkedList(error, ctx) {
	const details = Array.isArray(error.details) ? error.details : [];
	const baseLabel = ctx?.baseRef ? `from \`${ctx.baseRef}\`` : 'from the base branch';
	const ownedSet = new Set(ctx?.ownedFolders ?? []);
	const origin = (leafPath) => {
		if (!ctx || !leafPath) return '';
		return ownedSet.has(leafPath) ? ' (this branch)' : ` (${baseLabel})`;
	};

	const byParent = new Map();
	for (const conflict of details) {
		const parent = conflict.parentPath
			? migrationLink(conflict.parentPath)
			: `\`${conflict.parentId ?? '(unknown parent)'}\``;
		if (!byParent.has(parent)) byParent.set(parent, new Map());
		const leaves = byParent.get(parent);
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			const leaf = branch.leafPath
				? `${migrationLink(branch.leafPath)}${origin(branch.leafPath)}`
				: `\`${branch.leafId ?? '(unknown migration)'}\``;
			if (!leaves.has(leaf)) leaves.set(leaf, new Set());
			leaves.get(leaf).add(humanizeDescription(branch.statementDescription ?? ''));
		}
	}

	const lines = [];
	for (const [parent, leaves] of byParent) {
		lines.push('', `Migrations branching off ${parent}:`, '');
		for (const [leaf, descriptions] of leaves) {
			lines.push(`- ${leaf} — ⚠️ ${[...descriptions].join('; ')}`);
		}
	}
	return lines;
}

function regenerateCommands(ctx) {
	const wd = normalizedWd();
	const pmExec = (env.DRIZZLE_PM_EXEC || 'npx --no-install') === 'npx --no-install'
		? 'npx'
		: env.DRIZZLE_PM_EXEC;
	const config = env.DRIZZLE_CONFIG && env.DRIZZLE_CONFIG !== 'drizzle.config.ts'
		? ` --config ${env.DRIZZLE_CONFIG}`
		: '';

	const lastFolder = ctx.ownedFolders[ctx.ownedFolders.length - 1];
	const lastName = lastFolder.split('/').pop().split('_').slice(1).join('_');

	const commands = [];
	if (wd) commands.push(`cd ${wd}`);
	for (const folder of ctx.ownedFolders) commands.push(`rm -rf ${folder}`);
	commands.push(`${pmExec} drizzle-kit generate${lastName ? ` --name ${lastName}` : ''}${config}`);
	return commands;
}

function renderConflicts(error, ctx, dag) {
	const details = Array.isArray(error.details) ? error.details : [];
	const count = typeof error.conflicts === 'number' ? error.conflicts : details.length;

	const leafIds = new Set();
	for (const conflict of details) {
		for (const branch of Array.isArray(conflict.branches) ? conflict.branches : []) {
			leafIds.add(branch.leafId ?? branch.leafPath);
		}
	}

	const lines = [
		`### ❌ Conflicting migrations detected`,
		'',
		`Found **${count}** conflict${count === 1 ? '' : 's'}`
		+ (leafIds.size > 0 ? ` across **${leafIds.size}** migration${leafIds.size === 1 ? '' : 's'}.` : '.'),
		'',
		'These migrations were generated in parallel from the same parent migration and modify the same '
		+ 'database objects, so the resulting database state depends on the order they are applied in.',
	];

	const style = (env.DRIZZLE_GRAPH_STYLE || 'mermaid').toLowerCase();
	const neighborhood = dag ? conflictNeighborhood(error, dag) : null;

	if (style === 'tree') {
		lines.push('', ...renderDiffTree(error, ctx));
	} else if (style === 'list') {
		lines.push('', ...renderNestedList(error, ctx, neighborhood));
	} else {
		if (neighborhood && neighborhood.nodes.length <= 30) {
			lines.push('', ...renderMermaid(neighborhood, ctx));
		}
		lines.push(...renderLinkedList(error, ctx));
	}

	if (ctx && ctx.ownedFolders.length > 0) {
		const plural = ctx.ownedFolders.length === 1 ? '' : 's';
		lines.push(
			'',
			`To resolve this, update the branch with the latest ${ctx.baseRef ? `\`${ctx.baseRef}\`` : 'base branch'} `
			+ `(merge or rebase), then regenerate this branch's migration${plural} on top of the migrations it brings in:`,
			'',
			'```sh',
			...regenerateCommands(ctx),
			'```',
			'',
			'Commit the result and push.',
		);
	} else {
		lines.push(
			'',
			'To resolve this, regenerate the migration that belongs to this branch: update the branch with '
			+ 'the latest base branch, delete this branch\'s conflicting migration folder, and run '
			+ '`drizzle-kit generate` again so the migration is created on top of the latest one.',
		);
	}

	return lines.join('\n');
}

function renderError(error, exitCode) {
	const kind = error?.kind ? ` (\`${error.kind}\`)` : '';
	const message = error?.message ?? `drizzle-kit check failed with exit code ${exitCode}`;
	return `### ⚠️ drizzle-kit check failed${kind}\n\n${message}`;
}

function renderNotFound(workingDirectory) {
	return `### ⚠️ drizzle-kit not found\n\n`
		+ `\`drizzle-kit\` could not be resolved in \`${workingDirectory}\`. `
		+ `Make sure the workflow installs dependencies before this step and that \`drizzle-kit\` is a `
		+ `dependency of the package containing your drizzle config. In a monorepo, point the `
		+ `\`working-directory\` input at that package.`;
}

async function gh(method, path, token, body) {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'drizzle-check-action',
			'Content-Type': 'application/json',
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
	}
	return response;
}

async function findExistingComment(repo, prNumber, token) {
	let page = 1;
	while (true) {
		const response = await gh(
			'GET',
			`/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
			token,
		);
		const comments = await response.json();
		if (!Array.isArray(comments) || comments.length === 0) return null;
		const match = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(MARKER));
		if (match) return match;
		if (comments.length < 100) return null;
		page++;
	}
}

async function upsertComment(repo, prNumber, token, body) {
	const fullBody = `${MARKER}\n${body}`;
	const existing = await findExistingComment(repo, prNumber, token);
	if (existing) {
		await gh('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, token, { body: fullBody });
	} else {
		await gh('POST', `/repos/${repo}/issues/${prNumber}/comments`, token, { body: fullBody });
	}
}

async function main() {
	const exitCode = Number.parseInt(env.DRIZZLE_CHECK_EXIT_CODE ?? '0', 10) || 0;
	const envelope = parseEnvelope(env.DRIZZLE_CHECK_ENVELOPE);

	const token = env.GITHUB_TOKEN;
	const repo = env.GITHUB_REPOSITORY;
	const event = readEvent();
	const prNumber = resolvePrNumber(event);

	let body;
	let hasConflicts = false;
	let failed = exitCode !== 0;

	if (env.DRIZZLE_CHECK_NOT_FOUND === 'true') {
		body = renderNotFound(env.DRIZZLE_WORKING_DIRECTORY || '.');
		failed = true;
	} else if (envelope?.status === 'ok') {
		body = renderClean(envelope);
		failed = exitCode !== 0;
	} else if (
		envelope?.status === 'error'
		&& envelope.error?.code === 'check_error'
		&& envelope.error?.kind === 'conflicts'
	) {
		let ctx = null;
		if (prNumber && token && repo) {
			try {
				const files = await fetchPrFiles(repo, prNumber, token);
				ctx = buildBranchContext(envelope.error, files, event);
			} catch (e) {
				notice(`Could not determine which migrations belong to this PR: ${e instanceof Error ? e.message : e}`);
			}
		}
		let dag = null;
		try {
			dag = readMigrationDag(outDirsFromDetails(envelope.error));
		} catch {
			dag = null;
		}
		body = renderConflicts(envelope.error, ctx, dag);
		hasConflicts = true;
		failed = true;
	} else if (envelope?.status === 'error') {
		body = renderError(envelope.error, exitCode);
		failed = true;
	} else {
		body = renderError(undefined, exitCode);
		failed = true;
	}

	if (!prNumber || !token || !repo) {
		notice('No pull request context — skipping sticky comment.');
	} else {
		try {
			await upsertComment(repo, prNumber, token, body);
		} catch (e) {
			process.stdout.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
			// A comment-write failure must not mask a clean check, but must not hide conflicts either.
			if (!failed) process.exit(1);
		}
	}

	process.exit(hasConflicts || failed ? 1 : 0);
}

main().catch((e) => {
	process.stdout.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
});
