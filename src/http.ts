#!/usr/bin/env node
/**
 * Streamable-HTTP-Entry-Point (Stufe 2, docs/KICKOFF_MCP_INTEGRATION.md
 * Abschnitt 3, Hosting-Option a: Node-Prozess hinter nginx-Reverse-Proxy,
 * z. B. mcp.easycompliance.de).
 *
 * Architektur-Entscheidungen (alle aus dem Kickoff abgeleitet):
 *
 *  - STATELESS: Jeder POST erzeugt eine frische McpServer-/Transport-
 *    Instanz mit dem API-Key aus dem Header "X-API-Key" des Requests.
 *    Der Key wird 1:1 als X-API-Key an die REST-API durchgereicht und
 *    NIRGENDS gespeichert (kein eigener Key-Speicher, keine Sessions,
 *    keine Key-Persistenz). OAuth ist bewusst außerhalb des Scopes
 *    (Ausbaustufe, siehe README → Betrieb & Sicherheit).
 *
 *  - KEIN Logging von Namen/Prüfdaten/Keys im MCP-Layer (Datenschutz;
 *    das apilog der REST-API ist der Audit-Trail). Geloggt werden nur
 *    Startmeldung und Fehlermeldungstexte ohne Request-Daten.
 *
 *  - enableJsonResponse: Antworten als application/json statt SSE-Stream.
 *    Die Tools sind kurze Request/Response-Zyklen ohne Server-Pushes;
 *    JSON-Antworten sind hinter nginx robuster (kein Buffering-Thema)
 *    und von der Streamable-HTTP-Spezifikation ausdrücklich erlaubt.
 *
 *  - Bindet standardmäßig NUR an 127.0.0.1 – öffentlich erreichbar wird
 *    der Dienst ausschließlich über den nginx-Reverse-Proxy mit TLS
 *    (Vorlagen: deploy/nginx_mcp.conf.example, deploy/mcp-easycompliance.service.example).
 */

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { urlsFromEnv } from './config.js';
import { createServer, packageVersion } from './server.js';

/** Bind-Adresse/Port/Pfad – per Env überschreibbar (Defaults für den nginx-Proxy-Betrieb). */
const HOST = (process.env.MCP_HTTP_HOST ?? '').trim() || '127.0.0.1';
const PORT = Number.parseInt((process.env.MCP_HTTP_PORT ?? '').trim() || '8765', 10);
const PATH = (process.env.MCP_HTTP_PATH ?? '').trim() || '/mcp';

/** Obergrenze für Request-Bodys – MCP-Tool-Aufrufe sind klein, 1 MB ist großzügig. */
const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC-Fehlerantwort senden (einheitliches Fehlerformat für MCP-Clients). */
function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
	res.writeHead(httpStatus, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Request-Body mit Größenlimit einlesen. Liefert null, wenn das Limit
 * überschritten wurde. Bei Überschreitung wird der Stream nur PAUSIERT,
 * nicht zerstört (Codex-Review PR #271: req.destroy() kappte die Verbindung,
 * bevor die 413-Antwort den Client erreichte – Requests zwischen dem
 * 1-MB-Limit hier und dem nginx-Limit erhielten einen Connection-Reset
 * statt der dokumentierten JSON-RPC-Antwort). Die Pause stoppt den Client
 * per TCP-Backpressure; Node schließt die Verbindung nach der Antwort
 * selbst, weil der Request-Body nicht zu Ende gelesen wurde.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const onData = (chunk: Buffer): void => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				req.off('data', onData);
				req.pause();
				resolve(null);
				return;
			}
			chunks.push(chunk);
		};
		req.on('data', onData);
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/**
 * Einen MCP-POST stateless abarbeiten: Server + Transport pro Request,
 * Key aus dem X-API-Key-Header, nach Antwortende alles wieder schließen.
 */
async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
	// Auth-Gate VOR jeder Verarbeitung: ohne Key keine MCP-Kommunikation.
	// Die fachliche Key-Prüfung (401 bei ungültigem Key) macht die REST-API.
	const apiKey = String(req.headers['x-api-key'] ?? '').trim();
	if (apiKey === '') {
		sendJsonRpcError(res, 401, -32001, 'Missing X-API-Key header');
		return;
	}

	const rawBody = await readBody(req);
	if (rawBody === null) {
		// Verbindung nach der Antwort explizit schließen – der ungelesene
		// Rest des Bodys macht sie für Keep-Alive ohnehin unbrauchbar.
		res.setHeader('connection', 'close');
		sendJsonRpcError(res, 413, -32002, 'Request body too large');
		return;
	}
	let parsedBody: unknown;
	try {
		parsedBody = rawBody === '' ? undefined : JSON.parse(rawBody);
	} catch {
		sendJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
		return;
	}

	const server = createServer({ apiKey, ...urlsFromEnv() });
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	// Instanzen nach Antwortende schließen – bei stateless-Betrieb lebt
	// nichts über den Request hinaus (und damit auch der Key nicht).
	res.on('close', () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, parsedBody);
}

const httpServer = createHttpServer((req, res) => {
	const url = (req.url ?? '').split('?')[0];

	// Health-Endpoint für Supervision/Monitoring (systemd, nginx, Uptime-Checks).
	if (url === '/healthz') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok');
		return;
	}

	if (url !== PATH) {
		sendJsonRpcError(res, 404, -32004, 'Not found');
		return;
	}
	if (req.method !== 'POST') {
		// Stateless-Betrieb: kein GET-SSE-Stream, keine DELETE-Sessions.
		res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
		res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
		return;
	}

	handleMcpPost(req, res).catch((error: unknown) => {
		// Fehlermeldung ohne Request-Daten loggen (kein Key-/Namens-Leak).
		console.error('mcp-easycompliance http error:', error instanceof Error ? error.message : String(error));
		if (!res.headersSent) {
			sendJsonRpcError(res, 500, -32603, 'Internal server error');
		} else {
			res.end();
		}
	});
});

httpServer.listen(PORT, HOST, () => {
	console.error(`mcp-easycompliance ${packageVersion()} listening on http://${HOST}:${PORT}${PATH} (streamable HTTP, stateless)`);
});

// Sauberes Herunterfahren unter systemd (SIGTERM) und im Terminal (SIGINT).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		httpServer.close(() => process.exit(0));
		// Fallback, falls offene Verbindungen das close() blockieren.
		setTimeout(() => process.exit(0), 3000).unref();
	});
}
