# mcp-easycompliance

An [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server for [easycompliance](https://www.easycompliance.de/) – the German SaaS platform for automated sanctions list and PEP screening.

It lets AI agents (Claude Desktop, Claude Code, Cursor, agent frameworks and other MCP clients) screen business partners against EU/US/HADDEX sanctions lists and PEP lists, and maintain the daily monitoring list of an easycompliance account. The server is a pure consumer of the easycompliance REST API – executed tool calls (screenings, status/hit queries and executed monitoring changes) count towards the account's regular API quota and appear in the account's API log. Rejected requests (e.g. an invalid key) and deletion attempts without a matching entry are not logged.

## Tools

| Tool | Kind | Description |
|---|---|---|
| `check_sanctions_list(name, accuracy?)` | read-only | One-time screening of a name against the EU/US/HADDEX sanctions lists |
| `check_pep_list(name, accuracy?)` | read-only | One-time screening of a name against the PEP list (politically exposed persons) |
| `get_hits_last_24h(list)` | read-only | Hits produced by the daily monitoring within the last 24 hours |
| `get_list_status(list)` | read-only | Date (dd.mm.yyyy) of the last update of the selected list |
| `check_and_add_to_monitoring(list, name, ref?, duplicate_by?, accuracy?)` | write | Screens the name **and** adds it to the account's daily monitoring list |
| `remove_from_monitoring(list, by, value)` | write | Removes **one** matching entry from the daily monitoring list (by name or by reference) |

`list` is `"sanctions"` or `"pep"`. Screening results are always structured: `hit` (boolean), `hitCount` and `hits[]` with a `percent` match score – an empty result (HTTP 204 of the API) is returned as `hit: false`, never as an error.

### Compliance notes

- The tool results are the authoritative source. The tool descriptions instruct the calling model to **never soften, filter or omit hits**.
- If `hit` is `true`, the professional assessment of the match belongs in the easycompliance customer portal (<https://kunde.easycompliance.de>, Monitoring → Hits) – not in the AI conversation.
- `check_and_add_to_monitoring` has a persistent side effect (the name is re-screened daily and counts towards the account's monitoring quota); `remove_from_monitoring` removes monitoring entries. Both are clearly marked as write tools (no `readOnlyHint`), so MCP clients can require confirmation.
- `remove_from_monitoring` removes exactly **one** matching entry per call and is deliberately **not** marked idempotent: if several monitoring entries share the same name, a retried call removes another one of them. Use `by="ref"` with unique references to address a specific entry.

## Requirements

You need an easycompliance account with API access. Customer service (<https://www.easycompliance.de/>) provides:

- your **API key**,
- the **sanctions list API URL** and the **PEP API URL** (only needed if your account uses customer-specific URLs – the public defaults are built in).

## Configuration

All configuration is via environment variables. The MCP server itself never writes the key to a file and never logs it. Note that your MCP **client** stores the values you configure (including `EC_API_KEY`, as in the examples below) in its own configuration file, e.g. `claude_desktop_config.json` – protect that file like a password, and prefer your client's environment-variable or secret-management support where available.

| Variable | Required | Default | Description |
|---|---|---|---|
| `EC_API_KEY` | yes (stdio) | – | API key provided by easycompliance customer service |
| `EC_SANCTIONS_URL` | no | `https://www.easycompliance.de/easy.api` | Sanctions list API endpoint |
| `EC_PEP_URL` | no | `https://www.easycompliance.de/pep.api` | PEP API endpoint |

## Installation

The package runs with Node.js >= 20 and is started via `npx mcp-easycompliance` (stdio transport).

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "easycompliance": {
      "command": "npx",
      "args": ["-y", "mcp-easycompliance"],
      "env": {
        "EC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add easycompliance --env EC_API_KEY=your-api-key -- npx -y mcp-easycompliance
```

### Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "easycompliance": {
      "command": "npx",
      "args": ["-y", "mcp-easycompliance"],
      "env": {
        "EC_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Other MCP clients

Any MCP client that supports the stdio transport can run `npx -y mcp-easycompliance` with the `EC_API_KEY` environment variable set.

## Remote endpoint (streamable HTTP)

easycompliance hosts a remote endpoint with the identical tool set at `https://www.easycompliance.de/mcp.api` (streamable HTTP; implemented in PHP inside the easycompliance stack, verified against the same MCP SDK client test harness as this package). It works with remote clients that can send custom request headers, such as the OpenAI Responses API or MCP SDK clients; ChatGPT custom connectors depend on compatible authentication (OAuth is a planned extension, see below), so ChatGPT app support is in preparation.

The package also contains a second entry point, `mcp-easycompliance-http`, which serves the same tool set over streamable HTTP for **self-hosting** (e.g. enterprise deployments in your own infrastructure – see [`deploy/`](deploy/)):

- Authentication: the client sends its easycompliance API key in the **`X-API-Key`** request header; the server passes it through 1:1 to the REST API on every call. There is no key store, no session state and no persistence in the MCP layer.
- OAuth is currently out of scope (planned as a future extension for connector directories that require it).

Example (Claude Code):

```bash
claude mcp add --transport http easycompliance https://www.easycompliance.de/mcp.api --header "X-API-Key: your-api-key"
```

## Operations & security (self-hosting the HTTP endpoint)

Deployment templates (nginx reverse proxy, systemd unit, Dockerfile + step-by-step guide) are in [`deploy/`](deploy/):

- The Node process binds to `127.0.0.1` only; TLS and the public hostname are provided by the nginx reverse proxy.
- The server is **stateless**: each request creates a fresh server instance with the key from the request header; nothing outlives the request.
- The MCP layer logs **no names, no screening data and no keys** – the API's own log (`apilog`) is the audit trail for executed calls, which also count towards the account's API quota there.
- `GET /healthz` returns `200 ok` for uptime checks.

Environment variables of the HTTP entry point: `MCP_HTTP_HOST` (default `127.0.0.1`), `MCP_HTTP_PORT` (default `8765`), `MCP_HTTP_PATH` (default `/mcp`), plus `EC_SANCTIONS_URL`/`EC_PEP_URL` as above. `EC_API_KEY` is **not** used in HTTP mode – keys always come from the client request.

## API behaviour

The underlying REST API responds with HTTP 200 (JSON result array), 204 (no hit / no entry), 400 (invalid request body), 401 (invalid API key or suspended account), 403 (operation not included in the API plan) or 405 (non-POST). The server normalizes these into structured tool results and clear tool errors; an HTTP 200 without a result array is reported as a transport error and never as a clean "no hit". For `get_list_status`, an HTTP 204 (no completed list update verifiable yet) and a malformed date are reported as tool errors rather than as an empty status.

Known limitation of the API contract (shared with all API clients, including the n8n community node): for `check_and_add_to_monitoring` the API reports the screening result without a separate confirmation of the monitoring insertion – a server-side insert failure is logged on the server but not signalled in the HTTP response. Extending the API contract is outside the scope of this consumer package.

## Development

```bash
npm ci
npm run lint
npm run build
EC_API_KEY=<test-key> npm run livetest        # live harness (stdio logic) against the production API
EC_API_KEY=<test-key> npm run livetest:http   # live harness for the streamable HTTP transport
```

## Resources

- [easycompliance MCP integration guide (German)](https://www.easycompliance.de/schnittstellen/mcp/)
- [easycompliance API documentation (German)](https://www.easycompliance.de/schnittstellen/api/)
- [Model Context Protocol documentation](https://modelcontextprotocol.io/)

## License

[MIT](LICENSE)
