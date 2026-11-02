FROM python:3.11-slim-bookworm

# Makes Python logs show up immediately (no I/O buffering, so progress in the UI is real-time)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# System dependencies (FFmpeg for transcoding, curl/git/unzip as build tools,
# build-essential for any native wheels pip needs to compile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    # handbrake-cli \
    curl \
    git \
    unzip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Deno: JS runtime required by yt-dlp for sites that need it to resolve signatures
RUN curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno

# Pin yt-dlp to a fixed release instead of pulling "latest" on every build, so builds
# stay reproducible and a broken/behavior-changing upstream release can't surprise you.
ARG YTDLP_VERSION=2026.08.19
RUN curl -fL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Pre-create mount targets and config dir with sane ownership
RUN mkdir -p /media/inputs /media/outputs /app/config

# Keep pip's own tooling current before installing anything else
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Whisper is optional for smaller NAS/ARM deployments. Keep enabled by default
# for compatibility; disable with --build-arg INSTALL_WHISPER=false.
ARG INSTALL_WHISPER=true
ARG TORCH_VARIANT=cpu
COPY requirements.txt requirements-ai.txt ./
RUN pip install --no-cache-dir -r requirements.txt && \
    if [ "$INSTALL_WHISPER" = "true" ]; then \
      pip install --no-cache-dir torch --index-url "https://download.pytorch.org/whl/${TORCH_VARIANT}" && \
      pip install --no-cache-dir -r requirements-ai.txt; \
    fi

# Application source. Copied last so that changing app code doesn't invalidate the
# (much slower) dependency-installation layers above on rebuild.
COPY . .

# Entrypoint script so HOST/PORT can be overridden at runtime via environment variables
RUN printf '#!/bin/sh\nexec uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8080}"\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-8080}/api/health" || exit 1

CMD ["/app/entrypoint.sh"]
