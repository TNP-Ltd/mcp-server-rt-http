# mcp-server-rt image

A container image of [mcp-server-rt](https://github.com/bestpractical/mcp-server-rt), Best Practical's
MCP server for [RT](https://bestpractical.com/request-tracker), served over MCP Streamable HTTP by
[supergateway](https://github.com/supercorp-ai/supergateway). mcp-server-rt itself only speaks stdio,
so it can't be reached over the network on its own.

```
docker run --rm -p 8000:8000 \
  -e RT_URL=https://rt.example.com -e RT_TOKEN=<token> -e SUPERGATEWAY_API_KEY=<random> \
  ghcr.io/<owner>/<repo>:0.3.0-1
# MCP endpoint: http://localhost:8000/mcp (send Authorization: Bearer <random>), health: /healthz
```

| Variable | |
| --- | --- |
| `RT_URL` | Your RT, 6.0 or later (REST 2.0) |
| `RT_TOKEN` | An RT auth token (Settings > Auth Tokens). Everything is done as its user |
| `RT_TOKEN_FILE` | Instead of `RT_TOKEN`: a file holding the token, e.g. `/run/secrets/rt_token` |
| `SUPERGATEWAY_API_KEY` | Callers must send this as a bearer token. Required: the container won't start without a key |
| `SUPERGATEWAY_API_KEY_FILE` | Instead of `SUPERGATEWAY_API_KEY`: a file of keys, one per line, e.g. `/run/secrets/mcp_api_key` |

The server speaks plain HTTP, so put it behind a TLS-terminating proxy if it's reachable beyond localhost.

The default arguments serve every tool. mcp-server-rt has no read-only mode, so to offer only some,
replace the arguments and list them with `--tools` (any other call is refused by supergateway):

```
docker run ... ghcr.io/<owner>/<repo>:0.3.0-1 \
  --stdio=mcp-server-rt --outputTransport=streamableHttp --port=8000 --healthEndpoint=/healthz \
  --tools=search_tickets --tools=get_ticket --tools=get_ticket_history
```

and give the RT user only the rights it needs.

## Versions

Pinned in `package.json` and `package-lock.json`. To upgrade, change the versions in `package.json`, run
`npm install --package-lock-only --ignore-scripts`, commit, and tag the commit with the mcp-server-rt
version plus `-N` for rebuilds of the same version (e.g. `0.3.0-2`). The tag's build is published as
`ghcr.io/<owner>/<repo>:<tag>`.

## Licences

mcp-server-rt is GPL-2.0; its source is at https://github.com/bestpractical/mcp-server-rt, at the tag
matching the version in `package.json`. supergateway and the other dependencies are MIT, ISC or BSD.
