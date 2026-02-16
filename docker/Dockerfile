FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y \
    git curl jq unzip openssl ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Global npm packages
RUN npm install -g wrangler @anthropic-ai/claude-code

# Demo guide
COPY demo-guide.sh /root/demo-guide.sh
RUN chmod +x /root/demo-guide.sh

WORKDIR /root

CMD ["/bin/bash"]
