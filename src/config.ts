/**
 * Konfiguration des MCP-Servers.
 *
 * Der API-Key kommt je nach Transport aus unterschiedlichen Quellen
 * (STDIO: Umgebungsvariable EC_API_KEY; Streamable HTTP: Header X-API-Key
 * je Request) – die API-URLs kommen immer aus der Umgebung, weil sie
 * kundenindividuell sein können (gleiche Logik wie im n8n-Credential,
 * siehe docs/KICKOFF_MCP_INTEGRATION.md Abschnitt 1).
 *
 * Der Key wird bewusst NIE in Dateien gelesen oder geschrieben und nie
 * geloggt (Compliance-/Datenschutz-Anforderung des Kickoffs).
 */

/** Öffentliche Standard-Endpunkte der easycompliance-REST-API. */
export const DEFAULT_SANCTIONS_URL = 'https://www.easycompliance.de/easy.api';
export const DEFAULT_PEP_URL = 'https://www.easycompliance.de/pep.api';

/** Vollständige Konfiguration einer Server-Instanz (eine Instanz = ein Key). */
export interface EasycomplianceConfig {
	apiKey: string;
	sanctionsUrl: string;
	pepUrl: string;
}

/** API-URLs aus der Umgebung lesen (Fallback: öffentliche Endpunkte). */
export function urlsFromEnv(): { sanctionsUrl: string; pepUrl: string } {
	const sanctionsUrl = (process.env.EC_SANCTIONS_URL ?? '').trim() || DEFAULT_SANCTIONS_URL;
	const pepUrl = (process.env.EC_PEP_URL ?? '').trim() || DEFAULT_PEP_URL;
	return { sanctionsUrl, pepUrl };
}

/**
 * STDIO-Konfiguration aus der Umgebung lesen.
 *
 * Wirft bei fehlendem EC_API_KEY einen Error – der STDIO-Entry-Point
 * beendet sich dann mit einer verständlichen Meldung auf stderr
 * (stdout gehört beim STDIO-Transport ausschließlich dem MCP-Protokoll).
 */
export function configFromEnv(): EasycomplianceConfig {
	const apiKey = (process.env.EC_API_KEY ?? '').trim();
	if (apiKey === '') {
		throw new Error(
			'Missing EC_API_KEY environment variable. ' +
				'Set it to the API key provided by easycompliance customer service.',
		);
	}
	return { apiKey, ...urlsFromEnv() };
}
