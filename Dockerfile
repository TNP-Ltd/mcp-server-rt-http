FROM node:24.22.2-alpine

LABEL org.opencontainers.image.title="mcp-server-rt" \
      org.opencontainers.image.description="mcp-server-rt behind supergateway (MCP Streamable HTTP)" \
      org.opencontainers.image.licenses="GPL-2.0-only AND MIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
# rt-compact runs mcp-server-rt and shrinks its read-tool results (compact/transform.mjs).
COPY compact/index.mjs compact/transform.mjs /app/compact/
RUN chmod 755 /app/compact/index.mjs && ln -s /app/compact/index.mjs /usr/local/bin/rt-compact
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV PATH=/app/node_modules/.bin:$PATH \
    NODE_ENV=production
USER 1000:1000
EXPOSE 8000
ENTRYPOINT ["entrypoint.sh"]
CMD ["--stdio=rt-compact", "--outputTransport=streamableHttp", "--port=8000", "--healthEndpoint=/healthz"]
