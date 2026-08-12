/**
 * Server-Fabrik des easycompliance-MCP-Servers.
 *
 * Beide Transporte (STDIO + Streamable HTTP) erzeugen ihre McpServer-
 * Instanz ausschließlich über createServer() – so gibt es genau EINEN Ort,
 * an dem Tools und Server-Metadaten definiert sind (Kickoff Abschnitt 3:
 * "eine Tool-Definition, zwei Transporte").
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { EasycomplianceConfig } from './config.js';
import { registerEasycomplianceTools } from './tools.js';

/**
 * Paketversion zur Laufzeit aus package.json lesen (liegt im npm-Paket
 * immer eine Ebene über dist/). Fallback statt Absturz, falls das Paket
 * ungewöhnlich installiert wurde – die Version ist rein informativ.
 */
export function packageVersion(): string {
	try {
		const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/** McpServer-Instanz mit allen easycompliance-Tools erzeugen (eine Instanz = ein API-Key). */
export function createServer(config: EasycomplianceConfig): McpServer {
	const server = new McpServer({
		name: 'mcp-easycompliance',
		version: packageVersion(),
	});
	registerEasycomplianceTools(server, config);
	return server;
}
