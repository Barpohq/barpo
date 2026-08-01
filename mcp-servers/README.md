# Builtin MCP servers

The set of MCP servers that ship with the platform. Same idea as the `skills/`
directory: the entries here land in the catalog and the user installs them from
the MCP page.

**Empty for now** — the infrastructure is ready, the contents come later.
Which servers count as a "platform recommendation" is a product decision.

## Adding one

One directory per server, containing a `server.json` — the **official MCP
publish format** (byte-for-byte the same schema as
`registry.modelcontextprotocol.io`). That means an entry taken from the registry
can be copied in directly.

```
mcp-servers/
  filesystem/
    server.json
```

A stdio server example:

```json
{
  "name": "barpo/filesystem",
  "description": "Tools for working with the file system",
  "version": "1.0.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@modelcontextprotocol/server-filesystem",
      "version": "1.0.0",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "runtimeArguments": [{ "type": "positional", "value": "-y" }],
      "environmentVariables": [
        {
          "name": "ALLOWED_DIRS",
          "description": "Permitted directories (comma-separated)",
          "isRequired": true
        }
      ]
    }
  ]
}
```

A remote (http) server example:

```json
{
  "name": "barpo/remote",
  "description": "A remote MCP service",
  "version": "1.0.0",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": [
        {
          "name": "Authorization",
          "description": "Access token",
          "isRequired": true,
          "isSecret": true
        }
      ]
    }
  ]
}
```

## Important

- Fields marked `isSecret: true` are **not written to the database** — they live
  in a separate file (`~/.barpo/mcp-credentials.json`, `chmod 600`).
- After adding a file the server has to be restarted: the catalog is scanned on
  every startup (`mcp-builtin.ts`).
- If you edit an entry, **do not change** its `name`: syncing is keyed by name,
  and if the name changes the existing installs (and their credentials) are lost.
