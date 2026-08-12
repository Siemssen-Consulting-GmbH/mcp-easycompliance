/**
 * HTTP-Client für die easycompliance-REST-API (Sanktionslisten & PEP).
 *
 * Der MCP-Server ist reiner API-Konsument (docs/KICKOFF_MCP_INTEGRATION.md
 * Abschnitt 1): alle Aufrufe sind POST-Requests mit JSON-Body, die Antwort
 * ist je nach Operation ein JSON-Array (method 1–3), plain text (method=4)
 * oder ein leerer Body (204). Die Normalisierungslogik ist 1:1 vom Codex-
 * reviewten n8n-Node übernommen (n8n-nodes-easycompliance, PR #249):
 *
 *  - 204 ist der fachliche Normalfall "kein Treffer/kein Eintrag".
 *  - Ein 200 OHNE JSON-Array bei Prüf-/Treffer-Operationen ist ein
 *    Transportfehler und darf NIE als "kein Treffer" durchgehen
 *    (abgeschnittene Antwort/Proxy-Fehlerseite → falsch-sauberes Ergebnis).
 *  - 401/403/405 sind fachliche Fehlerbilder mit klarer Meldung.
 *
 * Authentifizierung: Der API-Key wird als Header "X-API-Key" gesendet
 * (von der API seit PR #249 unterstützt; Body-Feld api_key hätte Vorrang,
 * wird hier aber bewusst nicht genutzt). So nutzen STDIO- und Streamable-
 * HTTP-Transport denselben Code-Pfad, und der Key taucht nie im Request-
 * Body auf – der Remote-Transport reicht den Client-Header damit 1:1 durch
 * (Kickoff Abschnitt 3, "kein eigener Key-Speicher").
 */

import type { EasycomplianceConfig } from './config.js';

/** Beide API-Instanzen haben denselben Parametersatz – nur die URL unterscheidet sich. */
export type ListType = 'sanctions' | 'pep';

/** Fachlicher/transportbezogener API-Fehler mit klartext-Meldung für das aufrufende Modell. */
export class EasycomplianceApiError extends Error {}

/** Rohantwort eines API-Aufrufs vor der operationsspezifischen Normalisierung. */
export interface ApiResponse {
	status: number;
	/** Antwort-Body als String (leer bei 204). */
	text: string;
	/** Geparster Body, falls der Text wie JSON aussieht und parsebar ist – sonst undefined. */
	parsed: unknown;
}

/** Request-Timeout in ms – identisch zum n8n-Node (15 s). */
const REQUEST_TIMEOUT_MS = 15000;

/** Anzeigename der Instanz für Fehlermeldungen. */
export function listLabel(list: ListType): string {
	return list === 'pep' ? 'PEP' : 'sanctions list';
}

/** URL der API-Instanz je Listentyp aus der Konfiguration wählen. */
export function listUrl(config: EasycomplianceConfig, list: ListType): string {
	return list === 'pep' ? config.pepUrl : config.sanctionsUrl;
}

/**
 * Einen API-Aufruf ausführen und die Antwort defensiv vor-parsen.
 *
 * Wirft EasycomplianceApiError bei Netz-/Timeout-Problemen sowie bei den
 * bekannten Fehler-Statuscodes; 200/204 werden zur operationsspezifischen
 * Auswertung zurückgegeben.
 */
export async function callApi(
	config: EasycomplianceConfig,
	list: ListType,
	body: Record<string, string | number>,
): Promise<ApiResponse> {
	const url = listUrl(config, list);

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': config.apiKey,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		// Netzfehler/Timeout: Meldung OHNE Request-Daten (keine Namen/Keys in Logs/Fehlern).
		const reason = error instanceof Error ? error.message : String(error);
		throw new EasycomplianceApiError(
			`easycompliance ${listLabel(list)} API is not reachable (${reason})`,
		);
	}

	const text = (await response.text()) ?? '';
	const status = response.status;

	if (status === 401) {
		throw new EasycomplianceApiError(
			'easycompliance API: invalid API key or account suspended (HTTP 401)',
		);
	}
	if (status === 403) {
		// Abrechnungs-/Modul-Gate der API (api_modell 'kontingent'/'payg', PR #257):
		// die API liefert eine JSON-Fehlermeldung ({"error": "..."}) – durchreichen.
		const parsed = tryParseJson(text);
		const apiMessage =
			parsed && typeof parsed === 'object' && 'error' in parsed
				? String((parsed as { error: unknown }).error)
				: 'this operation is not included in your API plan';
		throw new EasycomplianceApiError(`easycompliance API: ${apiMessage} (HTTP 403)`);
	}
	if (status === 405) {
		throw new EasycomplianceApiError(
			'easycompliance API: request was rejected as non-POST (HTTP 405) – please report this to easycompliance support',
		);
	}
	if (status === 400) {
		throw new EasycomplianceApiError(
			'easycompliance API: request was rejected as invalid (HTTP 400 "Invalid JSON body") – please report this to easycompliance support',
		);
	}
	if (status !== 200 && status !== 204) {
		throw new EasycomplianceApiError(`easycompliance API: unexpected HTTP status ${status}`);
	}

	return { status, text, parsed: tryParseJson(text) };
}

/** JSON-Antworten defensiv parsen; Nicht-JSON (z. B. Datum bei method=4) bleibt undefined. */
function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Treffer-Array einer Prüf-/Treffer-Operation erzwingen.
 *
 * Die API liefert bei diesen Operationen 200 AUSSCHLIESSLICH mit einem
 * JSON-Array; "kein Treffer" ist immer 204. Ein 200 ohne Array darf NICHT
 * als hit:false durchgehen (Codex-Review PR #249 Runde 5 – falsch-sauberes
 * Prüfergebnis wäre im Sanktionskontext ein stiller Compliance-Fehler).
 */
export function requireResultArray(response: ApiResponse): Record<string, unknown>[] {
	if (response.status === 200 && !Array.isArray(response.parsed)) {
		throw new EasycomplianceApiError(
			'easycompliance API returned HTTP 200 without a result array – the response may be truncated or malformed',
		);
	}
	return Array.isArray(response.parsed) ? (response.parsed as Record<string, unknown>[]) : [];
}
