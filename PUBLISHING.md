# Veröffentlichung des MCP-Servers auf npm (interne Anleitung)

Diese Anleitung beschreibt Schritt für Schritt, wie `mcp-easycompliance`
in ein eigenes öffentliches Repository überführt und auf npm veröffentlicht
wird. Sie folgt dem erprobten Ablauf des n8n-Pakets
(`n8n-nodes-easycompliance/PUBLISHING.md`, Erstveröffentlichung 2026-07-31)
und übernimmt dessen gelernte Betriebsfakten.

---

## Schritt 1: Eigenes öffentliches GitHub-Repository anlegen

Der Ordner `mcp-easycompliance/` wird in ein **eigenes, öffentliches**
Repository überführt: `github.com/Siemssen-Consulting-GmbH/mcp-easycompliance`
(`repository.url`/`bugs.url` in `package.json` zeigen bereits dorthin).

Beim Anlegen auf GitHub **keine** Startdateien generieren lassen (README,
.gitignore und LICENSE bringt das Paket selbst mit).

**Datei-Upload-Liste** (Lehre aus dem n8n-Release: die Dotfiles wurden beim
ersten Upload vergessen – hier sind sie explizit aufgeführt):

```
.eslintrc.js                         ← DOTFILE, nicht vergessen!
.gitignore                           ← DOTFILE, nicht vergessen!
.github/workflows/npm-publish.yml    ← DOTFILE-Ordner, nicht vergessen!
LICENSE
PUBLISHING.md
README.md
deploy/DEPLOYMENT.md
deploy/Dockerfile.example
deploy/mcp-easycompliance.service.example
deploy/nginx_mcp.conf.example
package.json
package-lock.json
src/api.ts
src/config.ts
src/http.ts
src/server.ts
src/stdio.ts
src/tools.ts
test/livetest.mjs
test/livetest_http.mjs
tsconfig.json
```

(`node_modules/` und `dist/` werden NICHT hochgeladen – `.gitignore` deckt
beide ab; `dist/` entsteht beim Build.)

## Schritt 2: Lokal bauen, linten, testen

```bash
cd mcp-easycompliance
npm ci
npm run lint     # Standard-TypeScript-Lint – Findings beheben
npm run build    # kompiliert nach dist/
EC_API_KEY=<Testkunden-Key> npm run livetest        # Live-Harness (STDIO-Logik)
EC_API_KEY=<Testkunden-Key> npm run livetest:http   # Live-Harness (Streamable HTTP)
```

Der Testkunden-Key kommt vom Maintainer, wird nur als Umgebungsvariable
gesetzt und nie committet.

## Schritt 3: Auf npm veröffentlichen ✅ ERLEDIGT (2026-08-12)

**Status:** `mcp-easycompliance@0.1.0` ist veröffentlicht – über den
GitHub-Actions-Workflow im Org-Repo, inklusive Provenance-Attestation
(Registry-Feld `dist.attestations`). Verifiziert per Registry-Abfrage,
Testinstallation und Live-Lauf des installierten Pakets über echten
STDIO-Transport gegen die Produktions-API (4/4 PASS, 2026-08-12).

**Beim Erstrelease gelernter Betriebsfakt:** Der Workflow-Lauf erzeugte die
GitHub-Warnung „Node.js 20 is deprecated … being forced to run on
Node.js 24" – `actions/checkout@v4` und `actions/setup-node@v4` targeten
die abgekündigte Node-20-Runner-Runtime. Der Workflow in diesem Repo nutzt
seit dem Fix **v5** beider Actions; die Kopie im Org-Repo entsprechend
nachziehen.

**Noch offen (Maintainer):** In den npm-Paketeinstellungen den **Trusted
Publisher** auf das Org-Repo/Workflow konfigurieren, danach den
Granular-Token widerrufen und das GitHub-Secret `NPM_TOKEN` löschen.
Wichtig dafür: Der Workflow enthält seit dem Codex-Fix einen
`npm install -g npm@latest`-Schritt vor dem Publish – Trusted Publishing
(OIDC) setzt npm CLI ≥ 11.5.1 voraus, Node 22 bündelt eine ältere
Version. Beim Nachziehen der Workflow-Kopie im Org-Repo (v5-Actions)
diesen Schritt mit übernehmen.

Ursprüngliche Anleitung (der Vollständigkeit halber):

Der Actions-Workflow `.github/workflows/npm-publish.yml` ist 1:1 vom
n8n-Repo übernommen (workflow_dispatch + release-Trigger,
`npm publish --provenance --access public`). Gelernte Betriebsfakten
aus dem n8n-Release, die hier bereits berücksichtigt sind:

- **`node-version: 22`** (nicht 20) im Workflow.
- **Granular-Token für die Erstveröffentlichung:** Berechtigung *Read and
  write* mit Geltungsbereich **„All packages"** (ein auf einen Org-Scope
  beschränkter Token darf ein unscoped Paket nicht anlegen → 403) und
  **„Bypass two-factor authentication"** angehakt (CI kann kein OTP
  liefern). Token als GitHub-Secret `NPM_TOKEN` im neuen Repo hinterlegen.
- **Nach der Erstveröffentlichung:** In den npm-Paketeinstellungen den
  **Trusted Publisher** auf das GitHub-Repo/Workflow konfigurieren
  (wie beim n8n-Paket bereits eingerichtet), danach den Granular-Token
  **widerrufen** und das Secret `NPM_TOKEN` löschen. Zukünftige Releases
  laufen dann tokenlos über den Actions-Workflow mit Provenance-Signatur.

Ablauf der Erstveröffentlichung:

1. Paketname prüfen: `npm view mcp-easycompliance` → „404" = frei
   (Stand 2026-08-12: frei).
2. Granular-Token anlegen (siehe oben), als `NPM_TOKEN`-Secret hinterlegen.
3. Workflow „Publish to npm" manuell starten (workflow_dispatch) oder ein
   GitHub-Release `v0.1.0` anlegen.
4. Verifizieren: `npm view mcp-easycompliance version`, Testinstallation
   `npx -y mcp-easycompliance` (mit gesetztem `EC_API_KEY`) und ein
   Live-Lauf des installierten Pakets.
5. Trusted Publisher konfigurieren, Token widerrufen, Secret löschen.

## Schritt 4: Pflege

- Jede Änderung als neue **semver**-Version über den Actions-Workflow
  releasen (`version` in `package.json` erhöhen, Release anlegen).
- API-Änderungen von easycompliance (neue Parameter/Methoden) in
  `src/tools.ts`/`src/api.ts` nachziehen und im README dokumentieren.
- Bei SDK-Major-Updates (`@modelcontextprotocol/sdk`) die Livetests
  gegen die Produktions-API wiederholen, bevor released wird.
