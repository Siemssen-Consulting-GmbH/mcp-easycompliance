#!/usr/bin/env node
/**
 * STDIO-Entry-Point (Stufe 1, docs/KICKOFF_MCP_INTEGRATION.md Abschnitt 2).
 *
 * Kunden konfigurieren dieses Kommando in Claude Desktop, Claude Code,
 * Cursor & Co.; der API-Key kommt ausschließlich aus der Umgebungsvariable
 * EC_API_KEY (kein Key in Dateien/Argumenten). stdout gehört vollständig
 * dem MCP-Protokoll – alle Meldungen gehen deshalb auf stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { configFromEnv } from './config.js';
import { createServer, packageVersion } from './server.js';

async function main(): Promise<void> {
	const config = configFromEnv();
	const server = createServer(config);
	await server.connect(new StdioServerTransport());
	// Startmeldung bewusst ohne jegliche Konfigurationswerte (kein Key-Leak).
	console.error(`mcp-easycompliance ${packageVersion()} running on stdio`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
