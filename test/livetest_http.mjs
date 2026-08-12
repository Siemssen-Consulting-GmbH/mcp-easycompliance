/**
 * Live-Harness für den Streamable-HTTP-Transport (Stufe 2,
 * docs/KICKOFF_MCP_INTEGRATION.md Abschnitt 3).
 *
 * Startet dist/http.js als Kindprozess auf einem lokalen Port, verbindet
 * einen echten MCP-Client über StreamableHTTPClientTransport (Key im
 * X-API-Key-Header) und prüft denselben Kern-Umfang wie test/livetest.mjs
 * gegen die PRODUKTIONS-API – zusätzlich die HTTP-spezifischen Pfade
 * (fehlender Key → HTTP 401, /healthz, 405 für Nicht-POST).
 *
 * Aufruf:   EC_API_KEY=<Testkunden-Key> npm run livetest:http
 * Optional: EC_MCP_URL=https://mcp.easycompliance.de/mcp testet einen
 * BEREITS LAUFENDEN Remote-Endpunkt statt einen lokalen Server zu starten
 * (Deploy-Verifikation, siehe deploy/DEPLOYMENT.md Schritt 6).
 * Der Key kommt ausschließlich aus der Umgebung und wird nie geloggt.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const apiKey = (process.env.EC_API_KEY ?? '').trim();
if (apiKey === '') {
	console.error('FEHLER: EC_API_KEY ist nicht gesetzt (Testkunden-Key als Env-Var übergeben).');
	process.exit(1);
}

const externalUrl = (process.env.EC_MCP_URL ?? '').trim();
const PORT = 8917;
const MCP_URL = externalUrl !== '' ? externalUrl : `http://127.0.0.1:${PORT}/mcp`;
const BASE = new URL(MCP_URL).origin;

// Ohne EC_MCP_URL: HTTP-Server als Kindprozess starten (wie unter systemd).
let child = null;
if (externalUrl === '') {
	const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
	child = spawn(process.execPath, [join(serverDir, 'dist', 'http.js')], {
		env: { ...process.env, MCP_HTTP_PORT: String(PORT) },
		stdio: ['ignore', 'inherit', 'inherit'],
	});
}

// Auf den Health-Endpoint warten (max. 10 s).
async function waitForHealthz() {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${BASE}/healthz`);
			if (res.ok) return;
		} catch {
			// Server noch nicht bereit – weiter warten.
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error('HTTP-Server wurde nicht rechtzeitig bereit');
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

async function call(client, name, args) {
	const result = await client.callTool({ name, arguments: args });
	const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
	return { isError: result.isError === true, structured: result.structuredContent, text };
}

try {
	if (externalUrl === '') {
		await waitForHealthz();
		check('GET /healthz → 200', true);
	} else {
		// Externer Endpunkt: Der Node-Server bietet /healthz, der PHP-Endpunkt
		// (api/mcp.php im Hauptrepo) die projektübliche Statusprobe
		// ?status=check → "up". Eine der beiden Proben muss antworten.
		let alive = false;
		try {
			const h = await fetch(`${BASE}/healthz`);
			alive = h.ok;
		} catch {
			// /healthz nicht vorhanden – Statusprobe versuchen.
		}
		if (!alive) {
			const s = await fetch(`${MCP_URL}?status=check`);
			alive = s.ok && (await s.text()).trim() === 'up';
		}
		check('Erreichbarkeitsprobe (healthz oder ?status=check)', alive);
	}

	// Nicht-POST auf dem MCP-Pfad wird abgelehnt (stateless: kein GET-Stream).
	const getRes = await fetch(MCP_URL, { headers: { accept: 'application/json, text/event-stream' } });
	check('GET auf MCP-Pfad → 405', getRes.status === 405, `Status ${getRes.status}`);

	// Fehlender X-API-Key → HTTP 401 bereits auf Transport-Ebene.
	const noKeyRes = await fetch(MCP_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 }),
	});
	check('POST ohne X-API-Key → 401', noKeyRes.status === 401, `Status ${noKeyRes.status}`);

	// Echter MCP-Client mit Key im Header (wird 1:1 an die REST-API durchgereicht).
	const client = new Client({ name: 'mcp-easycompliance-livetest-http', version: '0.0.0' });
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		requestInit: { headers: { 'x-api-key': apiKey } },
	});
	await client.connect(transport);
	check('MCP-Client initialisiert über Streamable HTTP', true);

	const toolList = await client.listTools();
	check('tools/list liefert 6 Tools', toolList.tools.length === 6, `erhalten: ${toolList.tools.length}`);

	{
		const { isError, structured } = await call(client, 'get_list_status', { list: 'sanctions' });
		check(
			'get_list_status sanctions liefert Datum dd.mm.yyyy',
			!isError && /^\d{2}\.\d{2}\.\d{4}$/.test(structured?.lastUpdate ?? ''),
			JSON.stringify(structured),
		);
	}
	{
		const { isError, structured } = await call(client, 'check_sanctions_list', { name: 'Abu Brays' });
		check(
			'check_sanctions_list "Abu Brays" → hit=true',
			!isError && structured?.hit === true && structured?.hitCount > 0,
			`hit=${structured?.hit} hitCount=${structured?.hitCount}`,
		);
	}
	{
		const { isError, structured } = await call(client, 'check_pep_list', { name: 'Olaf Scholz' });
		check(
			'check_pep_list "Olaf Scholz" → hit=true',
			!isError && structured?.hit === true && structured?.hitCount > 0,
			`hit=${structured?.hit} hitCount=${structured?.hitCount}`,
		);
	}
	{
		const { isError, structured } = await call(client, 'check_sanctions_list', { name: 'Xyzqwe Flurbametrix Qoplon' });
		check(
			'Fantasiename → hit=false (204-Pfad)',
			!isError && structured?.hit === false && structured?.hitCount === 0,
			JSON.stringify(structured),
		);
	}

	// Monitoring-Roundtrip inkl. Zweitlöschung (Sauberkeitsbeweis).
	{
		const uniqueRef = `MCPTEST-http-${Date.now()}`;
		const add = await call(client, 'check_and_add_to_monitoring', {
			list: 'sanctions',
			name: `MCP HTTP-Livetest ${Date.now()}`,
			ref: uniqueRef,
			duplicate_by: 'ref',
		});
		check('check_and_add_to_monitoring (HTTP) ok', !add.isError && typeof add.structured?.hit === 'boolean', add.text);
		const remove1 = await call(client, 'remove_from_monitoring', { list: 'sanctions', by: 'ref', value: uniqueRef });
		check('remove_from_monitoring (HTTP) → removed=true', !remove1.isError && remove1.structured?.removed === true, remove1.text);
		const remove2 = await call(client, 'remove_from_monitoring', { list: 'sanctions', by: 'ref', value: uniqueRef });
		check('Zweitlöschung (HTTP) → removed=false', !remove2.isError && remove2.structured?.removed === false, remove2.text);
	}

	// Ungültiger Key: Transport akzeptiert, die REST-API antwortet 401 → Tool-Fehler.
	{
		const badClient = new Client({ name: 'mcp-easycompliance-livetest-http-bad', version: '0.0.0' });
		const badTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
			requestInit: { headers: { 'x-api-key': 'mcp-livetest-invalid-key' } },
		});
		await badClient.connect(badTransport);
		const { isError, text } = await call(badClient, 'check_sanctions_list', { name: 'Abu Brays' });
		check('Ungültiger Key → Tool-Fehler mit HTTP 401', isError && text.includes('401'), text);
	}
} finally {
	if (child !== null) {
		child.kill('SIGTERM');
	}
}

console.log(`\nErgebnis: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
