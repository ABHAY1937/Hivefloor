# Default Hivefloor agent sandbox (specs/003-agent-sandbox).
# Build: docker build -t hivefloor-agent:1 resources/sandbox
# The harness builds it automatically the first time a sandboxed agent starts.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates python3 ripgrep less openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Override to slim the image, e.g. --build-arg CLIS="@anthropic-ai/claude-code".
ARG CLIS="@anthropic-ai/claude-code @openai/codex @google/gemini-cli"
RUN if [ -n "$CLIS" ]; then npm install -g $CLIS && npm cache clean --force; fi

# Git refuses repos owned by another uid (the host user) without this.
RUN git config --system --add safe.directory '*'

USER node
WORKDIR /work
