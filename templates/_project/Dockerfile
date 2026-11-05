FROM node:24-slim
{{install}}
ENV API_HOST=0.0.0.0
EXPOSE 42069
# kasbah itself, not through the package manager: it gets the SIGTERM of a stop and finishes the block it's on.
CMD ["node", "node_modules/kasbah/dist/cli/main.js", "start"]
