/**
 * Live-Harness für den easycompliance-MCP-Server (Stufe 1, STDIO-Logik).
 *
 * Testet das GEBAUTE Paket (dist/) über einen echten MCP-Client mit
 * SDK-InMemory-Transport gegen die PRODUKTIONS-API mit einem
 * Testkunden-Key (docs/KICKOFF_MCP_INTEGRATION.md, Abschnitt "Qualität/
 * Tests"; Muster: n8n_node_livetest.cjs der n8n-Runde).
 *
 * Aufruf:   EC_API_KEY=<Testkunden-Key> npm run livetest
 *
 * Der Key kommt AUSSCHLIESSLICH aus der Umgebung und wird nie geloggt.
 * Monitoring-Testeinträge werden mit eindeutiger Referenz angelegt und im
 * selben Lauf wieder gelöscht (Zweitlöschung → removed=false als
 * Sauberkeitsbeweis, Kickoff Arbeitsregel 4).
 *
 * Testfälle (Kickoff):
 *  - "Abu Brays"   → Sanktionslisten-Treffer (hit=true)
 *  - "Olaf Scholz" → PEP-Treffer (hit=true)
 *  - Fantasiename  → 204-Pfad (hit=false)
 *  - get_list_status beider Listen (Datum dd.mm.yyyy)
 *  - Monitoring-Roundtrip beider Listen mit Referenz + Zweitlöschung
 *  - Client-seitige Validierungen + 401-Fehlerbild mit ungültigem Key
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../dist/server.js';
import { urlsFromEnv } from '../dist/config.js';

const apiKey = (process.env.EC_API_KEY ?? '').trim();
if (apiKey === '') {
	console.error('FEHLER: EC_API_KEY ist nicht gesetzt (Testkunden-Key als Env-Var übergeben).');
	process.exit(1);
}

/** MCP-Client an eine frische Server-Instanz mit gegebenem Key koppeln. */
async function connectClient(key) {
	const server = createServer({ apiKey: key, ...urlsFromEnv() });
	const client = new Client({ name: 'mcp-easycompliance-livetest', version: '0.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`PASS  ${label}`);
	} else {
		failed++;
		console.log(`FAIL  ${label}${detail !== '' ? ` – ${detail}` : ''}`);
	}
}

/** Tool aufrufen und strukturiertes Ergebnis + Fehlerstatus zurückgeben. */
async function call(client, name, args) {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
	return { isError: result.isError === true, structured: result.structuredContent, text };
}

const client = await connectClient(apiKey);

// ---- Tool-Discovery -------------------------------------------------------
const toolList = await client.listTools();
const toolNames = toolList.tools.map((t) => t.name).sort();
check(
	'tools/list liefert die 6 Kickoff-Tools',
	JSON.stringify(toolNames) ===
		JSON.stringify([
			'check_and_add_to_monitoring',
			'check_pep_list',
			'check_sanctions_list',
			'get_hits_last_24h',
			'get_list_status',
			'remove_from_monitoring',
		]),
	`erhalten: ${toolNames.join(', ')}`,
);
const readOnly = toolList.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
check(
	'readOnlyHint auf genau den 4 Lese-Tools',
	JSON.stringify(readOnly) ===
		JSON.stringify(['check_pep_list', 'check_sanctions_list', 'get_hits_last_24h', 'get_list_status']),
	`erhalten: ${readOnly.join(', ')}`,
);

// ---- get_list_status (method=4, beide Listen) -----------------------------
for (const list of ['sanctions', 'pep']) {
	const { isError, structured } = await call(client, 'get_list_status', { list });
	const dateOk = !isError && /^\d{2}\.\d{2}\.\d{4}$/.test(structured?.lastUpdate ?? '');
	check(`get_list_status ${list} liefert Datum dd.mm.yyyy`, dateOk, JSON.stringify(structured));
}

// ---- Einzelprüfung: bekannte Treffer (Kickoff-Testnamen) ------------------
{
	const { isError, structured } = await call(client, 'check_sanctions_list', { name: 'Abu Brays' });
	check(
		'check_sanctions_list "Abu Brays" → hit=true mit percent',
		!isError &&
			structured?.hit === true &&
			structured?.hitCount > 0 &&
			structured?.hits.every((h) => 'percent' in h),
		`hit=${structured?.hit} hitCount=${structured?.hitCount}`,
	);
}
{
	const { isError, structured } = await call(client, 'check_pep_list', { name: 'Olaf Scholz' });
	check(
		'check_pep_list "Olaf Scholz" → hit=true mit percent',
		!isError &&
			structured?.hit === true &&
			structured?.hitCount > 0 &&
			structured?.hits.every((h) => 'percent' in h),
		`hit=${structured?.hit} hitCount=${structured?.hitCount}`,
	);
}

// ---- Einzelprüfung: 204-Pfad (Fantasiename) -------------------------------
const fantasyName = 'Xyzqwe Flurbametrix Qoplon';
for (const [tool, list] of [
	['check_sanctions_list', 'sanctions'],
	['check_pep_list', 'pep'],
]) {
	const { isError, structured } = await call(client, tool, { name: fantasyName });
	check(
		`${tool} Fantasiename → hit=false (204-Pfad)`,
		!isError && structured?.hit === false && structured?.hitCount === 0 && Array.isArray(structured?.hits),
		JSON.stringify(structured),
	);
}

// ---- get_hits_last_24h (method=3, beide Listen) ---------------------------
for (const list of ['sanctions', 'pep']) {
	const { isError, structured } = await call(client, 'get_hits_last_24h', { list });
	check(
		`get_hits_last_24h ${list} liefert hitCount+hits[]`,
		!isError && typeof structured?.hitCount === 'number' && Array.isArray(structured?.hits),
		JSON.stringify({ hitCount: structured?.hitCount }),
	);
}

// ---- Monitoring-Roundtrip (method=2 → 5 → 5, beide Listen) ----------------
for (const list of ['sanctions', 'pep']) {
	const uniqueRef = `MCPTEST-${list}-${Date.now()}`;
	const testName = `MCP Livetest Eintrag ${Date.now()}`;

	const add = await call(client, 'check_and_add_to_monitoring', {
		list,
		name: testName,
		ref: uniqueRef,
		duplicate_by: 'ref',
	});
	check(
		`check_and_add_to_monitoring ${list} (ref=${uniqueRef}) → hit-Feld vorhanden`,
		!add.isError && typeof add.structured?.hit === 'boolean' && add.structured?.ref === uniqueRef,
		add.text,
	);

	const remove1 = await call(client, 'remove_from_monitoring', { list, by: 'ref', value: uniqueRef });
	check(`remove_from_monitoring ${list} (1. Löschung) → removed=true`, !remove1.isError && remove1.structured?.removed === true, remove1.text);

	const remove2 = await call(client, 'remove_from_monitoring', { list, by: 'ref', value: uniqueRef });
	check(
		`remove_from_monitoring ${list} (Zweitlöschung, 204-Beweis) → removed=false`,
		!remove2.isError && remove2.structured?.removed === false,
		remove2.text,
	);
}

// ---- Client-seitige Validierungen (kein API-Aufruf) -----------------------
{
	const { isError, text } = await call(client, 'check_sanctions_list', { name: '   ' });
	check('Leerer Name wird client-seitig abgelehnt', isError && text.includes('must not be empty'), text);
}
{
	const { isError, text } = await call(client, 'check_and_add_to_monitoring', {
		list: 'sanctions',
		name: 'Validierungstest',
		duplicate_by: 'ref',
	});
	check('duplicate_by=ref ohne ref wird client-seitig abgelehnt', isError && text.includes('non-empty'), text);
}
{
	const { isError, text } = await call(client, 'remove_from_monitoring', { list: 'pep', by: 'ref', value: ' ' });
	check('Leerer Löschschlüssel wird client-seitig abgelehnt', isError && text.includes('must not be empty'), text);
}

// ---- Fehlerbild: ungültiger API-Key → 401 ---------------------------------
{
	const badClient = await connectClient('mcp-livetest-invalid-key');
	const { isError, text } = await call(badClient, 'check_sanctions_list', { name: 'Abu Brays' });
	check('Ungültiger Key → Tool-Fehler mit HTTP 401', isError && text.includes('401'), text);
}

console.log(`\nErgebnis: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
