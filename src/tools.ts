/**
 * Gemeinsame Tool-Definitionen des easycompliance-MCP-Servers.
 *
 * EINE Definition für BEIDE Transporte (STDIO + Streamable HTTP), damit
 * nichts doppelt gepflegt wird (docs/KICKOFF_MCP_INTEGRATION.md Abschnitt 3).
 * Der Tool-Schnitt folgt exakt dem Kickoff (Abschnitt 2): Lese- und
 * Schreib-Tools sind strikt getrennt und über MCP-Tool-Annotations
 * (readOnlyHint) gekennzeichnet.
 *
 * Compliance-Design (verbindlich, Kernrisiko des Produkts):
 *  - Antworten sind IMMER strukturiert (hit boolean, hitCount, hits[] mit
 *    percent) – nie nur Freitext. Zusätzlich wird das JSON als Text-Content
 *    mitgeliefert, damit auch Clients ohne structuredContent-Support das
 *    vollständige Ergebnis sehen.
 *  - Die Tool-Descriptions verpflichten das aufrufende Modell, Treffer
 *    niemals abzuschwächen oder wegzufiltern; die fachliche Bewertung
 *    gehört bei hit=true in den easycompliance-Kundenbereich.
 *  - Schreib-Tools benennen explizit, was sie tun (tägliches Monitoring).
 *
 * Laufzeit-Validierungen (aus den Codex-Reviews des n8n-Nodes übernommen):
 *  - Leerer/Whitespace-Name würde serverseitig als leere Suche mit 204
 *    enden und als sauberes "kein Treffer" erscheinen, obwohl nichts
 *    geprüft wurde (PR #249 Runde 4) → früh ablehnen.
 *  - duplicate_by=ref ohne nicht-leere ref fiele serverseitig still auf
 *    Namens-Duplikaterkennung zurück (PR #249 Runde 3) → früh ablehnen.
 *  - Leerer Löschschlüssel: der Server-Guard antwortet zwar mit 204 und
 *    löscht nie, aber der Fehler gehört früh und verständlich gemeldet
 *    (Kickoff Abschnitt 2) → früh ablehnen.
 *
 * Typisierungs-Hinweis: Alle Schema-Konstanten werden per
 * "as unknown as ZodRawShapeCompat" auf den breiten SDK-Typ gecastet und
 * die Callback-Argumente pro Tool explizit gecastet. Grund: Sowohl die
 * generische Typ-Inferenz von McpServer.registerTool als auch die
 * strukturelle Assignability-Prüfung konkreter zod-Schemata gegen den
 * SDK-Union-Typ AnySchema (zod v3 | zod v4) laufen mit zod 3.25 +
 * SDK 1.30 in TS2589 ("Type instantiation is excessively deep") und
 * Compile-Zeiten von Minuten. Der unknown-Cast überspringt genau diese
 * Prüfung. Die LAUFZEIT-Validierung der Argumente durch zod ist davon
 * unberührt – nur die statische Ableitung der Argumenttypen entfällt.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { callApi, EasycomplianceApiError, requireResultArray } from './api.js';
import type { ListType } from './api.js';
import type { EasycomplianceConfig } from './config.js';

/**
 * Verbindlicher Compliance-Hinweis für alle Prüf-Tools. Er ist Teil der
 * Description und steuert damit direkt das Verhalten des aufrufenden
 * Modells (Kickoff Abschnitt 2, "Compliance-Design").
 */
const COMPLIANCE_NOTE =
	'COMPLIANCE: The tool result is the authoritative source. Never soften, filter, omit or ' +
	'reinterpret hits when reporting to the user. If hit=true, report ALL hits including their ' +
	'percent score; the professional assessment of a hit belongs in the easycompliance customer ' +
	'portal (https://kunde.easycompliance.de, Monitoring → Hits), not in this conversation.';

/** Auswahl der API-Instanz – beide Instanzen haben denselben Parametersatz. */
const LIST_PARAM = z
	.enum(['sanctions', 'pep'])
	.describe('Which easycompliance list to use: "sanctions" (EU/US/HADDEX sanctions lists) or "pep" (politically exposed persons)');

/** Optionale Suchgenauigkeit – Wertebereich wie im n8n-Node (50–100). */
const ACCURACY_PARAM = z
	.number()
	.int()
	.min(50)
	.max(100)
	.optional()
	.describe(
		'Search accuracy between 50 and 100 (percent). If not set, the search pattern configured for the easycompliance account is used.',
	);

/** Rohe Treffer-Datensätze der API – fachlich opak, ihre Struktur gehört der API. */
const HIT_RECORDS = z
	.array(z.custom<Record<string, unknown>>((value) => typeof value === 'object' && value !== null && !Array.isArray(value)))
	.describe('Full match records from the API, each including a "percent" match score');

/** Eingabeschema der Einzelprüfungen (method=1). */
const CHECK_INPUT = {
	name: z.string().describe('Name of the person or organization to screen (UTF-8)'),
	accuracy: ACCURACY_PARAM,
} as unknown as ZodRawShapeCompat;

/** Eingabeschema von check_and_add_to_monitoring (method=2). */
const MONITOR_INPUT = {
	list: LIST_PARAM,
	name: z.string().describe('Name of the person or organization to screen and monitor (UTF-8)'),
	ref: z.string().optional().describe('Your own reference, e.g. a customer, supplier or employee number'),
	duplicate_by: z
		.enum(['name', 'ref'])
		.optional()
		.describe(
			'Whether an entry is considered a duplicate by its name (default) or by its reference. "ref" requires a non-empty ref.',
		),
	accuracy: ACCURACY_PARAM,
} as unknown as ZodRawShapeCompat;

/** Eingabeschema von remove_from_monitoring (method=5). */
const REMOVE_INPUT = {
	list: LIST_PARAM,
	by: z.enum(['name', 'ref']).describe('Whether "value" identifies the monitoring entry by its name or by its reference'),
	value: z.string().describe('The name or reference of the entry to remove (must not be empty)'),
} as unknown as ZodRawShapeCompat;

/** Eingabeschema der Listen-Abfragen (method=3/4). */
const LIST_ONLY_INPUT = {
	list: LIST_PARAM,
} as unknown as ZodRawShapeCompat;

/** Ausgabeschema der Prüf-Operationen (method=1/2) – strukturiert, nie nur Freitext. */
const CHECK_OUTPUT = {
	name: z.string().describe('The screened name (as sent to the API)'),
	ref: z.string().describe('The reference that was sent along, empty if none'),
	hit: z.boolean().describe('true if the screening produced at least one potential match'),
	hitCount: z.number().describe('Number of potential matches'),
	hits: HIT_RECORDS,
} as unknown as ZodRawShapeCompat;

/** Ausgabeschema der Treffer-Abfrage (method=3). */
const HITS_OUTPUT = {
	hitCount: z.number().describe('Number of hits produced by the daily monitoring within the last 24 hours'),
	hits: HIT_RECORDS,
} as unknown as ZodRawShapeCompat;

/** Ausgabeschema von get_list_status (method=4). */
const STATUS_OUTPUT = {
	lastUpdate: z.string().describe('Date of the last list update, format dd.mm.yyyy'),
} as unknown as ZodRawShapeCompat;

/** Ausgabeschema von remove_from_monitoring (method=5). */
const REMOVE_OUTPUT = {
	removed: z.boolean().describe('true if an entry was removed, false if no matching entry existed'),
} as unknown as ZodRawShapeCompat;

/**
 * Tool-Ergebnis einheitlich aufbauen: structuredContent für moderne
 * Clients + dasselbe JSON als Text-Content für alle anderen.
 */
function toolResult(structured: Record<string, unknown>): CallToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
		structuredContent: structured,
	};
}

/** Fehler als Tool-Fehler (isError) melden, damit das Modell reagieren kann. */
function toolError(message: string): CallToolResult {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
	};
}

/**
 * Handler-Wrapper: fachliche API-Fehler werden als Tool-Fehler gemeldet
 * (nicht als Protokollfehler), unerwartete Fehler ohne Request-Daten.
 */
async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof EasycomplianceApiError) {
			return toolError(error.message);
		}
		const reason = error instanceof Error ? error.message : String(error);
		return toolError(`Unexpected error while calling the easycompliance API: ${reason}`);
	}
}

/** Gemeinsame Prüf-Logik für method=1 (Einzelprüfung) und method=2 (+ Monitoring). */
async function runCheck(
	config: EasycomplianceConfig,
	list: ListType,
	method: 1 | 2,
	name: string,
	options: { ref?: string; duplicateBy?: 'name' | 'ref'; accuracy?: number },
): Promise<CallToolResult> {
	// Leerer Name → früh ablehnen (siehe Kopf-Kommentar, PR #249 Runde 4).
	if (name.trim() === '') {
		return toolError('Parameter "name" must not be empty');
	}

	const body: Record<string, string | number> = { method, name };
	if (options.ref !== undefined && options.ref !== '') {
		body.ref = options.ref;
	}
	if (method === 2) {
		const duplicateBy = options.duplicateBy ?? 'name';
		// duplicate_by=ref ohne Referenz → früh ablehnen (siehe Kopf-Kommentar, PR #249 Runde 3).
		if (duplicateBy === 'ref' && String(body.ref ?? '').trim() === '') {
			return toolError('Duplicate detection "ref" requires a non-empty "ref" parameter');
		}
		body.duplicate_by = duplicateBy;
	}
	if (options.accuracy !== undefined) {
		body.accuracy = options.accuracy;
	}

	const response = await callApi(config, list, body);
	const hits = requireResultArray(response);
	return toolResult({
		name,
		ref: String(body.ref ?? ''),
		hit: hits.length > 0,
		hitCount: hits.length,
		hits,
	});
}

/**
 * Alle easycompliance-Tools an einer McpServer-Instanz registrieren.
 *
 * Die Konfiguration (inkl. API-Key) kommt vom Transport-Entry-Point:
 * STDIO liest sie einmalig aus der Umgebung, der Streamable-HTTP-Server
 * erzeugt pro Request eine Instanz mit dem Key aus dem X-API-Key-Header.
 */
export function registerEasycomplianceTools(server: McpServer, config: EasycomplianceConfig): void {
	server.registerTool(
		'check_sanctions_list',
		{
			title: 'Check name against sanctions lists',
			description:
				'One-time screening of a single person or organization name against the EU/US/HADDEX ' +
				'sanctions lists via the easycompliance API. No monitoring entry is created; like every ' +
				'executed API call, the screened name and result are recorded in the account\'s API log. ' +
				'Returns hit (boolean), hitCount and hits[] with a percent match score. ' +
				COMPLIANCE_NOTE,
			inputSchema: CHECK_INPUT,
			outputSchema: CHECK_OUTPUT,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const { name, accuracy } = args as { name: string; accuracy?: number };
			return runTool(() => runCheck(config, 'sanctions', 1, name, { accuracy }));
		},
	);

	server.registerTool(
		'check_pep_list',
		{
			title: 'Check name against PEP list',
			description:
				'One-time screening of a single person name against the PEP list (politically exposed ' +
				'persons) via the easycompliance API. No monitoring entry is created; like every executed ' +
				'API call, the screened name and result are recorded in the account\'s API log. Returns ' +
				'hit (boolean), hitCount and hits[] with a percent match score. ' +
				COMPLIANCE_NOTE,
			inputSchema: CHECK_INPUT,
			outputSchema: CHECK_OUTPUT,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const { name, accuracy } = args as { name: string; accuracy?: number };
			return runTool(() => runCheck(config, 'pep', 1, name, { accuracy }));
		},
	);

	server.registerTool(
		'get_hits_last_24h',
		{
			title: 'Get monitoring hits of the last 24 hours',
			description:
				'Returns the hits that easycompliance\'s DAILY monitoring produced within the last ' +
				'24 hours for the account, as hitCount and hits[] (name, reference, time, result). ' +
				COMPLIANCE_NOTE,
			inputSchema: LIST_ONLY_INPUT,
			outputSchema: HITS_OUTPUT,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const { list } = args as { list: ListType };
			return runTool(async () => {
				const response = await callApi(config, list, { method: 3 });
				const hits = requireResultArray(response);
				return toolResult({ hitCount: hits.length, hits });
			});
		},
	);

	server.registerTool(
		'get_list_status',
		{
			title: 'Get date of last list update',
			description:
				'Returns the date (dd.mm.yyyy) of the last update of the selected easycompliance list ' +
				'(sanctions lists or PEP list). Useful to verify data freshness.',
			inputSchema: LIST_ONLY_INPUT,
			outputSchema: STATUS_OUTPUT,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (args) => {
			const { list } = args as { list: ListType };
			return runTool(async () => {
				// method=4 antwortet mit plain text (z. B. "31.07.2026"), nicht mit JSON.
				const response = await callApi(config, list, { method: 4 });
				// 204 = kein nachweislich abgeschlossener Listen-Import (die PEP-API
				// antwortet bei method=4 fail-closed, apipep.php). Ein leerer
				// Datenstand darf NICHT als gültiger Status durchgehen, sonst kann
				// der Client fehlende Frische-Nachweise nicht von einem echten
				// Datum unterscheiden (Codex-Review PR #271 Runde 2).
				if (response.status === 204) {
					return toolError(
						'easycompliance API: no completed list update is verifiable for this list yet (HTTP 204) – treat the list status as unknown',
					);
				}
				const lastUpdate = response.text.trim();
				// Formatprüfung dd.mm.yyyy: eine 200-Antwort ohne Datum (z. B.
				// Proxy-Fehlerseite) wäre sonst ein falsch-plausibler Datenstand.
				if (!/^\d{2}\.\d{2}\.\d{4}$/.test(lastUpdate)) {
					return toolError(
						'easycompliance API returned an unexpected list status format – the response may be truncated or malformed',
					);
				}
				return toolResult({ lastUpdate });
			});
		},
	);

	server.registerTool(
		'check_and_add_to_monitoring',
		{
			title: 'Check name and add to daily monitoring',
			description:
				'Screens the name like check_sanctions_list/check_pep_list AND adds it to ' +
				'easycompliance\'s DAILY monitoring list: from then on the name is re-screened every day ' +
				'and new hits are reported to the account (persistent side effect; each monitored name ' +
				'counts towards the account\'s monitoring quota). Use duplicate_by="ref" with a non-empty ' +
				'ref to distinguish different partners that share the same name. Each call – including ' +
				'retries – is a separate billable API request that counts towards the account\'s API ' +
				'quota, even when duplicate detection prevents a second monitoring entry. ' +
				COMPLIANCE_NOTE,
			inputSchema: MONITOR_INPUT,
			outputSchema: CHECK_OUTPUT,
			// BEWUSST ohne idempotentHint (Codex-Review PR #271 Runde 3): Die
			// Duplikaterkennung verhindert zwar eine zweite Monitoring-Zeile,
			// aber jeder wiederholte method-2-Aufruf wird per apilog()
			// protokolliert und zählt erneut ins API-Kontingent (ggf. mit
			// Kosten) – ein Client-Retry ist also nicht frei von zusätzlichen
			// außenwirksamen Effekten.
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (args) => {
			const { list, name, ref, duplicate_by, accuracy } = args as {
				list: ListType;
				name: string;
				ref?: string;
				duplicate_by?: 'name' | 'ref';
				accuracy?: number;
			};
			return runTool(() => runCheck(config, list, 2, name, { ref, duplicateBy: duplicate_by, accuracy }));
		},
	);

	server.registerTool(
		'remove_from_monitoring',
		{
			title: 'Remove entry from daily monitoring',
			description:
				'Removes an entry from easycompliance\'s DAILY monitoring list, identified either by its ' +
				'name (by="name") or by its reference (by="ref"). The name is then no longer re-screened ' +
				'daily. Returns removed=true if an entry was found and removed, removed=false if no ' +
				'matching entry existed. NOTE: exactly ONE matching entry is removed per call – if ' +
				'several monitoring entries share the same name (created via duplicate_by="ref"), a ' +
				'repeated call removes another one of them, so do not retry after removed=true and ' +
				'prefer by="ref" with unique references to address a specific entry.',
			inputSchema: REMOVE_INPUT,
			outputSchema: REMOVE_OUTPUT,
			// BEWUSST ohne idempotentHint (Codex-Review PR #271 Runde 2): Die API
			// löscht pro Aufruf genau EINE passende Zeile (deleteNameListenpruefung
			// nutzt getOne). Bei mehreren gleichnamigen Einträgen entfernt eine
			// Wiederholung also einen WEITEREN Geschäftspartner aus dem täglichen
			// Monitoring – ein Client-Retry wäre nicht folgenlos.
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
		},
		async (args) => {
			const { list, by, value } = args as { list: ListType; by: 'name' | 'ref'; value: string };
			return runTool(async () => {
				// Leerer Löschschlüssel → früh und verständlich ablehnen (der Server-
				// Guard würde zwar mit 204 antworten und nie löschen, aber das Modell
				// soll den Anwendungsfehler sofort sehen, Kickoff Abschnitt 2).
				if (value.trim() === '') {
					return toolError('Parameter "value" must not be empty');
				}
				const body: Record<string, string | number> = { method: 5 };
				if (by === 'ref') {
					body.duplicate_by = 'ref';
					body.ref = value;
				} else {
					body.name = value;
				}
				const response = await callApi(config, list, body);
				// 200 = Eintrag war vorhanden und wurde entfernt, 204 = nicht gefunden.
				return toolResult({ removed: response.status === 200 });
			});
		},
	);
}
