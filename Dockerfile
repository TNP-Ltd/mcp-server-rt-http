FROM node:24.22.2-alpine

LABEL org.opencontainers.image.title="mcp-server-rt" \
      org.opencontainers.image.description="mcp-server-rt behind supergateway (MCP Streamable HTTP)" \
      org.opencontainers.image.licenses="GPL-2.0-only AND MIT"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

ENV PATH=/app/node_modules/.bin:$PATH \
    NODE_ENV=production
USER 1000:1000
EXPOSE 8000
ENTRYPOINT ["entrypoint.sh"]
CMD ["--stdio=mcp-server-rt", "--outputTransport=streamableHttp", "--port=8000", "--healthEndpoint=/healthz"]
