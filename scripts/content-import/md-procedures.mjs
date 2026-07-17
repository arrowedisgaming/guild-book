// Orchestrator: builds static/content-packs/hmtw/tarot-procedures.json and
// docs/rules/tarot-procedure-audit.md from manifest/tarot-procedures-md.json and
// the Markdown vault. Follows md-rules.mjs conventions.
//
//   node scripts/content-import/md-procedures.mjs                    # write both
//   node scripts/content-import/md-procedures.mjs --check            # verify committed == fresh
//   node scripts/content-import/md-procedures.mjs --check-generated  # verify without the vault
//   node scripts/content-import/md-procedures.mjs --dry-run          # preview, write nothing
//
// --check re-extracts every table from the local vault and validates every
// declared source heading, so a renamed heading or a changed table fails the
// build. It is the only check that proves the output matches the book.
//
// --check-generated never opens the ignored copyrighted Markdown, so CI can run
// it. Be precise about what that buys, because it is easy to overstate:
//   it DOES verify   procedures/modifiers/formulas and the audit re-render from
//                    the manifest, and that every table's declared id/title/deck/
//                    bracketConvention/source still matches the committed output.
//   it does NOT verify table ROWS. Those cannot be re-derived without the book.
//
// So committed row text is covered by *tamper-evidence* (the content digest in
// verify-pack-version.mjs proves the bytes were not edited after generation) and
// by *local* re-extraction. Neither proves, in CI, that a row matches the
// rulebook — only that nobody changed it since a human ran the real --check.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MD_DIR, extractSection, extractTable } from './md-lib.mjs';
import { PACK_DIR, ROOT } from './pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, 'manifest', 'tarot-procedures-md.json');
const PROCEDURES_JSON = join(PACK_DIR, 'tarot-procedures.json');
const AUDIT_MD = join(ROOT, 'docs', 'rules', 'tarot-procedure-audit.md');

const SCHEMA_VERSION = 2;

/** Proves a declared source still resolves, so a renamed heading fails locally. */
function assertSourceResolves(source, label) {
	if (source.anchor) {
		const raw = readFileSync(join(MD_DIR, source.file), 'utf8');
		if (!raw.split('\n').some((l) => l.trimStart().startsWith(source.anchor))) {
			throw new Error(`[${label}] anchor not found in ${source.file}: ${JSON.stringify(source.anchor)}`);
		}
		return;
	}
	extractSection(source.file, source.heading, undefined, source.after);
}

const sourceKey = (source) =>
	JSON.stringify([source.file, source.heading ?? null, source.after ?? null, source.anchor ?? null]);

/** Validate definition and invocation evidence against the local rulebook vault. */
export function validateProcedureManifestSources(manifest) {
	for (const entry of manifest.entries) {
		assertSourceResolves(entry.source, `${entry.id}.source`);
		if (entry.scope !== 'supported-v1') continue;
		if (!Array.isArray(entry.invokedFrom) || entry.invokedFrom.length === 0) {
			throw new Error(`[${entry.id}] supported-v1 needs invokedFrom`);
		}
		const keys = entry.invokedFrom.map(sourceKey);
		if (new Set(keys).size !== keys.length) {
			throw new Error(`[${entry.id}] duplicate invokedFrom citation`);
		}
		entry.invokedFrom.forEach((source, index) =>
			assertSourceResolves(source, `${entry.id}.invokedFrom[${index}]`)
		);
	}
}

/** Map source-heading slugs to canonical content ids without editing extracted rows. */
function normalizeTableReferences(tables, referenceAliases = {}) {
	return tables.map((table) => ({
		...table,
		rows: table.rows.map((row) => ({
			...row,
			cells: row.cells.map((cell) => ({
				...cell,
				references: cell.references.map((reference) => ({
					...reference,
					entryId:
						referenceAliases[reference.collection]?.[reference.entryId] ?? reference.entryId
				}))
			}))
		}))
	}));
}

/** Runtime catalog: supported entries only, deterministically ordered. */
export function compileProcedureContent(manifest, tables) {
	return {
		schemaVersion: SCHEMA_VERSION,
		procedures: manifest.entries
			.filter((entry) => entry.scope === 'supported-v1')
			.map(({ rationale: _rationale, ...entry }) => entry)
			.sort((a, b) => a.id.localeCompare(b.id)),
		lookupTables: normalizeTableReferences(tables, manifest.referenceAliases).sort((a, b) =>
			a.id.localeCompare(b.id)
		),
		modifiers: [...manifest.modifiers].sort((a, b) => a.id.localeCompare(b.id)),
		formulas: [...manifest.formulas].sort((a, b) => a.id.localeCompare(b.id))
	};
}

const escapePipes = (text) => String(text ?? '').replaceAll('|', '\\|');

/** Deterministic audit: no timestamps, no absolute paths, fixed ordering. */
export function renderAudit(manifest) {
	const rows = [...manifest.entries]
		.sort(
			(a, b) =>
				a.source.file.localeCompare(b.source.file) ||
				String(a.source.heading ?? a.source.anchor).localeCompare(
					String(b.source.heading ?? b.source.anchor)
				) ||
				a.id.localeCompare(b.id)
		)
		.map((entry) => {
			const formatSource = (source) => {
				const where = source.heading ?? `(bullet) ${source.anchor}`;
				return `${escapePipes(source.file)} — ${escapePipes(where)}`;
			};
			const invoked = entry.invokedFrom?.map(formatSource).join('<br>') ?? '';
			return `| ${entry.id} | ${escapePipes(entry.title)} | ${entry.scope} | ${formatSource(entry.source)} | ${invoked} | ${escapePipes(entry.rationale ?? '')} |`;
		});

	const counts = manifest.entries.reduce((acc, e) => {
		acc[e.scope] = (acc[e.scope] ?? 0) + 1;
		return acc;
	}, {});

	return [
		'# Tarot Procedure Audit',
		'',
		'<!-- Generated by scripts/content-import/md-procedures.mjs. Do not edit by hand. -->',
		'',
		'Every tarot-bearing rule found in the rulebook, enumerated once and classified.',
		'Review of this finite list is what "v1 completeness" means: the product makes no',
		'claim over unenumerated prose. `supported-v1` entries reach the runtime catalog;',
		'the rest are audit-only and carry a rationale.',
		'',
		`- \`supported-v1\`: ${counts['supported-v1'] ?? 0}`,
		`- \`deferred-preparation\`: ${counts['deferred-preparation'] ?? 0}`,
		`- \`not-applicable-non-tarot\`: ${counts['not-applicable-non-tarot'] ?? 0}`,
		'',
		'| ID | Procedure | Scope | Defined at | Invoked from | Rationale |',
		'|---|---|---|---|---|---|',
		...rows,
		''
	].join('\n');
}

/** Extracts every declared table from the vault. */
function buildTables(manifest) {
	return manifest.lookupTables.map((declared) => {
		const { rows, columns, axis, deck } = extractTable(
			declared.source.file,
			declared.source.heading,
			declared.source.after,
			{
				anchor: declared.source.anchor,
				deck: declared.deck,
				bracketConvention: Boolean(declared.bracketConvention)
			}
		);
		return {
			id: declared.id,
			title: declared.title,
			deck,
			...(declared.bracketConvention ? { bracketConvention: declared.bracketConvention } : {}),
			axis,
			columns,
			rows,
			source: declared.source
		};
	});
}

function readManifest() {
	return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** Committed runtime JSON, minus the tables (which need the vault to rebuild). */
function compileWithoutVault(manifest) {
	const committed = JSON.parse(readFileSync(PROCEDURES_JSON, 'utf8'));
	return compileProcedureContent(manifest, committed.lookupTables ?? []);
}

/**
 * Verify the committed tables still agree with what the manifest declares.
 *
 * Table *rows* cannot be re-derived without the vault, but every declared
 * attribute can be: id, title, deck, bracketConvention, and source. Without
 * this, editing a table's deck or source in the manifest passed CI silently,
 * because compileWithoutVault copies the committed tables straight back in.
 */
function checkDeclaredTables(manifest, committed) {
	const problems = [];
	const byId = new Map(committed.lookupTables.map((t) => [t.id, t]));
	for (const declared of manifest.lookupTables) {
		const actual = byId.get(declared.id);
		if (!actual) {
			problems.push(`declared table ${declared.id} is missing from the committed output`);
			continue;
		}
		for (const key of ['title', 'deck', 'bracketConvention']) {
			if (JSON.stringify(declared[key]) !== JSON.stringify(actual[key])) {
				problems.push(
					`${declared.id}.${key}: manifest ${JSON.stringify(declared[key])} vs committed ${JSON.stringify(actual[key])}`
				);
			}
		}
		if (JSON.stringify(declared.source) !== JSON.stringify(actual.source)) {
			problems.push(`${declared.id}.source differs from the manifest`);
		}
	}
	for (const id of byId.keys()) {
		if (!manifest.lookupTables.some((t) => t.id === id)) {
			problems.push(`committed table ${id} is not declared in the manifest`);
		}
	}
	return problems;
}

const serialize = (value) => JSON.stringify(value, null, '\t') + '\n';

function main() {
	const args = process.argv.slice(2);
	const manifest = readManifest();

	// CI path: no vault, so verify only what the manifest implies.
	if (args.includes('--check-generated')) {
		const fresh = compileWithoutVault(manifest);
		const committed = JSON.parse(readFileSync(PROCEDURES_JSON, 'utf8'));
		let drift = 0;
		for (const key of ['procedures', 'modifiers', 'formulas']) {
			if (serialize(fresh[key]) !== serialize(committed[key])) {
				console.error(`DRIFT ${key}`);
				drift++;
			}
		}
		if (serialize(renderAudit(manifest)) !== serialize(readFileSync(AUDIT_MD, 'utf8'))) {
			console.error('DRIFT tarot-procedure-audit.md');
			drift++;
		}
		for (const problem of checkDeclaredTables(manifest, committed)) {
			console.error(`DRIFT lookupTables — ${problem}`);
			drift++;
		}
		console.log(
			`\nChecked ${fresh.procedures.length} procedures, ${manifest.lookupTables.length} table declarations, and the audit against the manifest, ${drift} drifted.` +
				'\nNote: table ROWS are not re-extracted here — that needs the Markdown vault, which CI does not have.' +
				'\nRow text is covered only by the content digest (tamper-evidence), NOT by re-derivation from the book.'
		);
		if (drift) process.exit(1);
		return;
	}

	if (!existsSync(MD_DIR)) {
		throw new Error(
			`Markdown vault not found at ${MD_DIR}. Tarot procedures are built from the gitignored assets-src/HMTW_md/ book export. Use --check-generated where the vault is unavailable.`
		);
	}

	validateProcedureManifestSources(manifest);
	for (const modifier of manifest.modifiers) assertSourceResolves(modifier.source, modifier.id);
	for (const formula of manifest.formulas) assertSourceResolves(formula.source, formula.id);

	const tables = buildTables(manifest);
	const content = compileProcedureContent(manifest, tables);
	const audit = renderAudit(manifest);

	if (args.includes('--check')) {
		let drift = 0;
		if (serialize(content) !== readFileSync(PROCEDURES_JSON, 'utf8')) {
			console.error('DRIFT tarot-procedures.json');
			drift++;
		}
		if (audit !== readFileSync(AUDIT_MD, 'utf8')) {
			console.error('DRIFT tarot-procedure-audit.md');
			drift++;
		}
		const rowCount = tables.reduce((n, t) => n + t.rows.length, 0);
		console.log(
			`\nChecked ${content.procedures.length} procedures, ${tables.length} tables (${rowCount} rows), ${drift} drifted.`
		);
		if (drift) process.exit(1);
		return;
	}

	for (const table of tables) {
		console.log(`  ${table.id.padEnd(22)} ${table.deck.padEnd(5)} ${table.axis.padEnd(12)} ${table.rows.length} rows`);
	}

	if (!args.includes('--dry-run')) {
		mkdirSync(dirname(AUDIT_MD), { recursive: true });
		writeFileSync(PROCEDURES_JSON, serialize(content), 'utf8');
		writeFileSync(AUDIT_MD, audit, 'utf8');
		console.log(`\nWrote ${content.procedures.length} procedures to ${PROCEDURES_JSON}`);
		console.log(`Wrote ${manifest.entries.length} audit rows to ${AUDIT_MD}`);
	} else {
		console.log(`\n${content.procedures.length} procedures previewed (no write).`);
	}
}

main();
