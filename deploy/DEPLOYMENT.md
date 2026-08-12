# Deployment: Remote-MCP-Endpunkt `mcp.easycompliance.de` (Stufe 2)

Diese Anleitung beschreibt den Betrieb des easycompliance-MCP-Servers als
Remote-Endpunkt (Streamable HTTP) nach **Hosting-Option a** aus
`docs/KICKOFF_MCP_INTEGRATION.md`: Node-Prozess auf vs187 hinter einem
nginx-Reverse-Proxy. DNS/vhost/TLS richtet der Maintainer ein; dieses
Verzeichnis liefert die fertigen Vorlagen.

Es gibt zwei Betriebsvarianten – **auf vs187 (CentOS 7) ist Variante B
(Docker) die empfohlene**, weil die offiziellen Node-Binaries dort nicht
laufen (Details im Abschnitt „Node.js auf vs187"):

| Variante | Prozess | Supervision | Vorlagen |
|---|---|---|---|
| A: Direktinstallation | global installiertes npm-Paket | systemd | `mcp-easycompliance.service.example` |
| B: Docker (Plesk-Erweiterung) | Container auf Basis `node:22-alpine` | Docker Restart-Policy + Healthcheck | `Dockerfile.example` |

Der nginx-Reverse-Proxy (`nginx_mcp.conf.example`) ist für beide Varianten
identisch.

## Architektur

```
KI-Client (MCP-Client, Agent-Framework, Connector)
    │  HTTPS, Header: X-API-Key: <Kunden-Key>
    ▼
nginx (mcp.easycompliance.de, TLS)          → deploy/nginx_mcp.conf.example
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
- **OAuth ist außerhalb des Scopes** dieser Ausbaustufe. Für die
  Connector-Verzeichnisse von claude.ai/ChatGPT (die OAuth verlangen) wäre
  ein OAuth-Layer eine spätere Ausbaustufe; der Endpunkt ist bis dahin für
  Clients nutzbar, die eigene Header setzen können (MCP-SDK-Clients,
  Agent-Frameworks, Enterprise-Integrationen).

## Variante A: Direktinstallation mit systemd

Geeignet für Hosts mit lauffähigem Node.js ≥ 20 (auf vs187/CentOS 7 nur
über Unofficial Builds möglich – siehe „Node.js auf vs187").

1. **Node.js ≥ 20 bereitstellen.**
2. **Paket installieren:** `npm install -g mcp-easycompliance`
   (oder Checkout des Repos + `npm ci && npm run build`).
3. **systemd-Unit einrichten:** `deploy/mcp-easycompliance.service.example`
   nach `/etc/systemd/system/mcp-easycompliance.service` kopieren, Pfade
   prüfen, `systemctl enable --now mcp-easycompliance`.
4. **Lokal testen:** `curl -s http://127.0.0.1:8765/healthz` → `ok`.
5. Weiter mit „Gemeinsame Schritte: DNS, nginx, Ende-zu-Ende-Test".

## Variante B: Docker-Container über die Plesk-Docker-Erweiterung (empfohlen für vs187)

Der Container bringt sein eigenes Userland mit (Node 22 auf Alpine) –
damit ist das glibc-Problem von CentOS 7 gelöst; der 3.10er-Kernel des
Hosts genügt für den Container-Betrieb.

### B.1 Plesk-Docker-Erweiterung installieren

Plesk → **Erweiterungen → Katalog → „Docker"** installieren.

- Die Verwaltung des **lokalen** Docker-Dienstes ist **kostenlos** in der
  Erweiterung enthalten.
- Das kostenpflichtige Add-on **„Docker Remote Node Management" wird NICHT
  benötigt** – es dient ausschließlich dazu, Docker-Dienste auf ANDEREN
  (entfernten) Servern aus Plesk heraus zu verwalten. Unser Container
  läuft lokal auf vs187.

### B.2 Docker-Engine auf CentOS 7 bereitstellen

Falls noch keine Docker-Engine installiert ist:

```bash
# Docker-CE-Repo einbinden und letzte fuer el7 verfuegbare Version installieren
yum install -y yum-utils
yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
yum install -y docker-ce docker-ce-cli containerd.io
systemctl enable --now docker
docker --version
```

Betriebshinweise (wichtig auf CentOS 7):

- CentOS 7 ist EOL – neuere Docker-Releases liefern keine el7-Pakete mehr;
  installiert wird automatisch die **letzte für el7 verfügbare**
  Docker-CE-Version aus dem Repo.
- **Mindestens Docker 20.10.10 / runc ≥ 1.0.2** verwenden: Ältere
  seccomp-Profile beantworten neuere glibc-Syscalls (`faccessat2`,
  `clone3`) mit `EPERM` statt `ENOSYS` – moderne `node:22`-Images starten
  dann nicht. Die letzten el7-Pakete (Docker 24.x) erfüllen das.

### B.3 Image bauen

`deploy/Dockerfile.example` als `Dockerfile` in ein Arbeitsverzeichnis
kopieren (z. B. `/root/mcp-easycompliance/`) und bauen:

```bash
cd /root/mcp-easycompliance
docker build -t mcp-easycompliance:latest .
# Versionspinning (empfohlen fuer reproduzierbare Deployments):
# docker build --build-arg MCP_VERSION=0.1.0 -t mcp-easycompliance:0.1.0 .
```

Der Build lädt das npm-Paket aus der Registry; das Image enthält einen
Healthcheck auf `/healthz` und läuft als unprivilegierter Nutzer `node`.

### B.4 Container starten – Port-Binding beachten!

```bash
# Umgebungsdatei anlegen (dauerhafte Konfiguration, uebersteht Updates):
# leer lassen, wenn die oeffentlichen API-Endpunkte gelten; nur bei
# kundenindividuellen URLs EC_SANCTIONS_URL=... / EC_PEP_URL=... eintragen.
touch /root/mcp-easycompliance/mcp.env

docker run -d --name mcp-easycompliance \
    --restart always \
    --env-file /root/mcp-easycompliance/mcp.env \
    -p 127.0.0.1:8765:8765 \
    mcp-easycompliance:latest
```

- **`-p 127.0.0.1:8765:8765` ist sicherheitskritisch:** Der Host-Port muss
  an 127.0.0.1 gebunden werden, damit der Endpunkt nur über den
  nginx-Reverse-Proxy (TLS) erreichbar ist. **Achtung Plesk-UI:** Das
  *automatische* Port-Mapping der Docker-Erweiterung bindet an ALLE
  Interfaces (0.0.0.0) – der MCP-Port wäre dann ohne TLS öffentlich
  erreichbar. Deshalb den Container per CLI wie oben starten (er erscheint
  anschließend trotzdem in der Plesk-Docker-UI und ist dort verwaltbar)
  oder in der UI das manuelle Mapping nutzen und den Port zusätzlich per
  Firewall absichern.
- Im Image ist `MCP_HTTP_HOST=0.0.0.0` gesetzt – das ist container-intern
  nötig, damit das Port-Mapping greift; nach außen bleibt der Dienst durch
  das 127.0.0.1-Binding des HOST-Ports lokal.
- Kundenindividuelle API-URLs gehören in die **Umgebungsdatei `mcp.env`**
  (`EC_SANCTIONS_URL=…` / `EC_PEP_URL=…`; Defaults: öffentliche
  Endpunkte) – NICHT als einmalige `-e`-Optionen: Die Datei wird beim
  Update-Neustart (B.6) wieder mitgegeben, ad-hoc-`-e`-Werte gingen dort
  verloren und der Server fiele still auf die öffentlichen Endpunkte
  zurück (Codex-Review PR #271 Runde 7). `EC_API_KEY` wird im HTTP-Modus
  NICHT gesetzt – Keys kommen je Request vom Client.

### B.5 Lokal testen

```bash
curl -s http://127.0.0.1:8765/healthz   # -> ok
docker ps                               # STATUS: Up … (healthy)
```

Danach weiter mit „Gemeinsame Schritte: DNS, nginx, Ende-zu-Ende-Test".

### B.6 Betrieb (Variante B)

- **Updates** (neue Paketversion): Image neu bauen und Container ersetzen –
  die Umgebungsdatei aus B.4 wird dabei wieder mitgegeben, damit
  kundenindividuelle API-URLs den Neustart überstehen:
  ```bash
  cd /root/mcp-easycompliance
  docker build --pull --no-cache -t mcp-easycompliance:latest .
  docker stop mcp-easycompliance && docker rm mcp-easycompliance
  docker run -d --name mcp-easycompliance --restart always \
      --env-file /root/mcp-easycompliance/mcp.env \
      -p 127.0.0.1:8765:8765 mcp-easycompliance:latest
  ```
- **Supervision:** `--restart always` startet den Container nach Absturz
  und Server-Reboot neu; der Docker-Healthcheck meldet den Zustand in
  `docker ps` und der Plesk-Docker-UI. Die systemd-Unit aus Variante A
  entfällt.
- **Logs:** `docker logs mcp-easycompliance` enthält nur Start-/
  Fehlermeldungen ohne Namen, Keys oder Prüfdaten.

## Gemeinsame Schritte (beide Varianten): DNS, nginx, Ende-zu-Ende-Test

1. **DNS + Plesk-Subdomain + TLS** für `mcp.easycompliance.de` anlegen
   (Maintainer), dann die nginx-Blöcke aus `deploy/nginx_mcp.conf.example`
   in Plesk („Zusätzliche nginx-Anweisungen") eintragen.
2. **Ende-zu-Ende testen** (Key nur als Env-Var):
   `EC_API_KEY=<Testkunden-Key> EC_MCP_URL=https://mcp.easycompliance.de/mcp npm run livetest:http`
   – bzw. der Kern-Smoke-Test von Hand:

   ```bash
   # MCP-konformer Smoke-Test: initialize ist die vorgeschriebene erste
   # Protokoll-Interaktion (Codex-Review PR #271 Runde 5 – ein tools/list
   # ohne Handshake funktioniert im aktuellen Stateless-Modus zwar, ist
   # aber nicht spezifikationskonform und könnte mit künftigen
   # SDK-Versionen brechen). Erwartete Antwort: result.serverInfo.name
   # = "mcp-easycompliance".
   curl -s -X POST https://mcp.easycompliance.de/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -H "X-API-Key: $EC_API_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}'
   ```

   (`EC_MCP_URL` schaltet den Harness auf den bereits laufenden
   Remote-Endpunkt um; ohne die Variable startet er einen lokalen Server.
   Zusätzlich sinnvoll: ein echter MCP-Client, z. B.
   `claude mcp add --transport http easycompliance https://mcp.easycompliance.de/mcp --header "X-API-Key: <Key>"`.)

## Node.js auf vs187 (CentOS 7 – wichtiger Betriebshinweis)

Der Produktivserver läuft auf CentOS 7.9 (glibc 2.17). Die **offiziellen**
Node-Binaries ab Node 18 setzen glibc ≥ 2.28 voraus und starten dort
nicht. Optionen (Entscheidung beim Maintainer):

1. **Docker-Container (empfohlen, → Variante B):** Das Image bringt sein
   eigenes Userland mit; die Plesk-Docker-Erweiterung verwaltet den
   Container lokal und kostenlos.
2. **Unofficial Builds (→ Variante A):** nodejs.org stellt unter
   <https://unofficial-builds.nodejs.org/> `linux-x64-glibc-217`-Builds
   bereit, die auf CentOS 7 laufen. Vor Einsatz die gewünschte
   Node-22-Version dort auf Verfügbarkeit prüfen.
3. **Anderer Host:** Den MCP-Prozess auf einem kleinen separaten Host
   betreiben (entspricht dann Hosting-Option c aus dem Kickoff); die
   Vorlagen beider Varianten gelten dort unverändert.

## Betrieb (Variante A)

- **Updates:** `npm update -g mcp-easycompliance && systemctl restart mcp-easycompliance`.
- **Monitoring:** `/healthz` (HTTP 200 „ok") für Uptime-Checks; Prozess-
  Neustart übernimmt systemd (`Restart=always`).
- **Logs:** `journalctl -u mcp-easycompliance` enthält nur Start-/
  Fehlermeldungen ohne Namen, Keys oder Prüfdaten.
