# Deployment: Selbst gehosteter Remote-MCP-Endpunkt (Streamable HTTP)

> **Hinweis zum offiziellen easycompliance-Endpunkt:** easycompliance
> betreibt seinen gehosteten Remote-Endpunkt seit dem 2026-08-12 als
> **PHP-Implementierung im Hauptstack** (`api/mcp.php` im Hauptrepo,
> Route `https://www.easycompliance.de/mcp.api` – Stufe-2-Hosting-Option b
> aus `docs/KICKOFF_MCP_INTEGRATION.md`; Maintainer-Entscheid, da der
> Produktivserver keinen root-Shell-Zugriff bietet). Er wird mit dem
> normalen Website-Deploy ausgeliefert und braucht KEINE der folgenden
> Schritte.
>
> Dieses Dokument beschreibt das **Selbst-Hosting** des Node-basierten
> Endpunkts (`mcp-easycompliance-http` aus dem npm-Paket) – z. B. für
> Enterprise-Kunden, die den MCP-Server in der eigenen Infrastruktur
> betreiben wollen. Beide Implementierungen bedienen denselben
> Tool-Schnitt; der MCP-SDK-Client-Harness (`test/livetest_http.mjs`,
> `EC_MCP_URL`-Modus) läuft gegen beide identisch grün.

Zwei Betriebsvarianten:

| Variante | Prozess | Supervision | Vorlagen |
|---|---|---|---|
| A: Direktinstallation | global installiertes npm-Paket | systemd | `mcp-easycompliance.service.example` |
| B: Docker, Eigenbau | Container auf Basis `node:22-alpine` | Docker Restart-Policy + Healthcheck | `Dockerfile.example` |

Der nginx-Reverse-Proxy (`nginx_mcp.conf.example`, Hostname dort als
Beispiel) ist für beide Varianten identisch.

## Architektur

```
KI-Client (MCP-Client, Agent-Framework, Connector)
    │  HTTPS, Header: X-API-Key: <Kunden-Key>
    ▼
nginx (TLS)                                 → deploy/nginx_mcp.conf.example
    │  Proxy auf 127.0.0.1:8765, Header unverändert
    ▼
mcp-easycompliance-http                     → Variante A: systemd-Unit
(Node-Prozess oder Docker-Container)          Variante B: Dockerfile.example
    │  stateless: pro Request eine Server-Instanz, kein Key-Speicher
    ▼
easycompliance-REST-API (easy.api / pep.api) – X-API-Key wird 1:1 durchgereicht
```

Sicherheits-/Datenschutz-Eigenschaften (verbindlich, aus dem Kickoff):

- **Kein eigener Key-Speicher:** Der Key existiert nur für die Dauer des
  einzelnen Requests im Speicher; es gibt keine Sessions und keine
  Persistenz.
- **Kein Logging von Namen/Prüfdaten** im MCP-Layer – das `apilog` der
  REST-API ist der Audit-Trail für ausgeführte Aufrufe. Jeder AUSGEFÜHRTE
  Tool-Aufruf zählt dort wie ein direkter API-Aufruf ins Kontingent des
  Kunden; abgewiesene Anfragen (401/403) und Löschversuche ohne passenden
  Eintrag protokolliert die API dagegen nicht.
- **OAuth ist außerhalb des Scopes** dieser Ausbaustufe. Für
  Connector-Verzeichnisse, die OAuth verlangen, wäre ein OAuth-Layer eine
  spätere Ausbaustufe; der Endpunkt ist bis dahin für Clients nutzbar, die
  eigene Header setzen können (MCP-SDK-Clients, Agent-Frameworks,
  Enterprise-Integrationen).

## Variante A: Direktinstallation mit systemd

Setzt lauffähiges Node.js ≥ 20 voraus (Achtung bei alten glibc-Versionen
< 2.28, z. B. CentOS 7: offizielle Node-Binaries ab Node 18 starten dort
nicht – dann Unofficial Builds
(<https://unofficial-builds.nodejs.org/>, `linux-x64-glibc-217`)
verwenden oder Variante B wählen, deren Container das Userland mitbringt).

1. **Node.js ≥ 20 bereitstellen.**
2. **Paket installieren:** `npm install -g mcp-easycompliance`
   (oder Checkout des Repos + `npm ci && npm run build`).
3. **systemd-Unit einrichten:** `deploy/mcp-easycompliance.service.example`
   nach `/etc/systemd/system/mcp-easycompliance.service` kopieren, Pfade
   prüfen, `systemctl enable --now mcp-easycompliance`.
4. **Lokal testen:** `curl -s http://127.0.0.1:8765/healthz` → `ok`.
5. Weiter mit „Gemeinsame Schritte".

## Variante B: Docker-Container (Eigenbau)

1. Docker-Engine bereitstellen (≥ 20.10.10 / runc ≥ 1.0.2 – ältere
   seccomp-Profile beantworten neuere glibc-Syscalls wie `faccessat2`/
   `clone3` falsch, moderne `node:22`-Images starten dann nicht).
2. `deploy/Dockerfile.example` als `Dockerfile` in ein Arbeitsverzeichnis
   kopieren und bauen:
   ```bash
   docker build --build-arg MCP_VERSION=0.1.0 -t mcp-easycompliance:0.1.0 .
   ```
3. Container starten – **Host-Port zwingend an 127.0.0.1 binden** (der
   Endpunkt darf nur über den TLS-Reverse-Proxy erreichbar sein; Achtung:
   Docker-Port-Mappings umgehen INPUT-basierte Host-Firewalls):
   ```bash
   touch mcp.env   # dauerhafte Env-Datei; nur bei kundenindividuellen
                   # API-URLs EC_SANCTIONS_URL=/EC_PEP_URL= eintragen
   docker run -d --name mcp-easycompliance --restart always \
       --env-file "$(pwd)/mcp.env" \
       -p 127.0.0.1:8765:8765 \
       mcp-easycompliance:0.1.0
   ```
   `EC_API_KEY` wird im HTTP-Modus NICHT gesetzt – Keys kommen je Request
   vom Client. Die Env-Datei (statt einmaliger `-e`-Optionen) übersteht
   das Neuerstellen beim Update.
4. **Lokal testen:** `curl -s http://127.0.0.1:8765/healthz` → `ok`;
   `docker ps` → `Up … (healthy)`.
5. Weiter mit „Gemeinsame Schritte".
6. **Updates:** Image mit `--pull --no-cache` neu bauen, Container
   ersetzen (gleiches `docker run`-Kommando inkl. `--env-file`).

## Gemeinsame Schritte (beide Varianten): DNS, nginx, Ende-zu-Ende-Test

1. **DNS + vhost + TLS** für den gewünschten Hostnamen einrichten, dann
   die nginx-Blöcke aus `deploy/nginx_mcp.conf.example` übernehmen
   (bei Plesk: „Zusätzliche nginx-Anweisungen" des vhosts).
2. **Ende-zu-Ende testen** (Key nur als Env-Var):
   `EC_API_KEY=<Key> EC_MCP_URL=https://<mcp-host>/mcp npm run livetest:http`
   – bzw. der Kern-Smoke-Test von Hand:

   ```bash
   # MCP-konformer Smoke-Test: initialize ist die vorgeschriebene erste
   # Protokoll-Interaktion. Erwartete Antwort: result.serverInfo.name
   # = "mcp-easycompliance".
   curl -s -X POST https://<mcp-host>/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -H "X-API-Key: $EC_API_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}'
   ```

## Betrieb

- **Monitoring:** `/healthz` (HTTP 200 „ok") für Uptime-Checks.
- **Updates:** Variante A `npm update -g mcp-easycompliance` +
  `systemctl restart`; Variante B siehe oben.
- **Logs:** journalctl bzw. `docker logs` enthalten nur Start-/
  Fehlermeldungen ohne Namen, Keys oder Prüfdaten.
