/**
 * ESLint-Konfiguration für den MCP-Server: Standard-TypeScript-Lint
 * (im Gegensatz zum n8n-Paket ohne n8n-spezifisches Plugin – hier gibt es
 * keine n8n-Konventionen zu prüfen, siehe docs/KICKOFF_MCP_INTEGRATION.md).
 */
module.exports = {
	root: true,
	parser: '@typescript-eslint/parser',
	parserOptions: {
		sourceType: 'module',
	},
	plugins: ['@typescript-eslint'],
	extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
	ignorePatterns: ['dist/**', 'node_modules/**', 'test/**'],
	env: {
		node: true,
		es2022: true,
	},
};
