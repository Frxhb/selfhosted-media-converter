FROM python:3.11-slim-bookworm

# Macht Python-Logs sofort sichtbar (kein I/O-Buffering für Echtzeit-Fortschritt im UI)
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# System-Abhängigkeiten installieren (FFmpeg, HandBrake, Node.js für yt-dlp Engine)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    handbrake-cli \
    curl \
    git \
    unzip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Deno als JS-Runtime für yt-dlp installieren
RUN curl -fsSL https://deno.land/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno

# yt-dlp Version fest pinnen statt "latest" bei jedem Build zu ziehen.
ARG YTDLP_VERSION=2026.07.04
RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Ziel-Ordner für Mounts und Configs vorab mit passenden Rechten anlegen
RUN mkdir -p /media/inputs /media/outputs /app/config

# Build-Tools vorab aktualisieren
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Python Abhängigkeiten installieren (inklusive gallery-dl)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gallery-dl

# Anwendungs-Code kopieren
COPY . .

# Startskript für Port & Host Konfiguration
RUN printf '#!/bin/sh\nexec uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8080}"\n' > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-8080}/api/health" || exit 1

CMD ["/app/entrypoint.sh"]
