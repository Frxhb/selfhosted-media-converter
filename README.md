# Media Converter

<p align="center">
  <img src="docs/banner.png" alt="Media Converter Banner" width="100%">
</p>

<p align="center">
  Self-hosted media processing platform for downloading, converting, transcribing and managing audio, video and image files.
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/Frxhb/media-converter-selfhosted?style=flat-square" alt="GitHub Stars">
  <img src="https://img.shields.io/github/license/Frxhb/media-converter-selfhosted?style=flat-square" alt="License">
  <img src="https://img.shields.io/github/last-commit/Frxhb/media-converter-selfhosted?style=flat-square" alt="Last Commit">
  <img src="https://img.shields.io/badge/Python-3.x-blue?style=flat-square&logo=python" alt="Python Version">
  <img src="https://img.shields.io/badge/Docker-supported-blue?style=flat-square&logo=docker" alt="Docker">
  <img src="https://img.shields.io/badge/FastAPI-powered-009688?style=flat-square&logo=fastapi" alt="FastAPI">
</p>

---

## Screenshots

<!-- Replace placeholders with actual screenshots -->

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard Screenshot" width="85%">
</p>

<p align="center">
  <img src="docs/screenshots/converter.png" alt="Converter Screenshot" width="85%">
</p>

<p align="center">
  <img src="docs/screenshots/logs.png" alt="Live Logs Screenshot" width="85%">
</p>

---

## Overview

Disclaimer: Vibe-Coding Project. GUI mainly in german right now. English version coming soon...

Media Converter is a self-hosted media toolkit for downloading, converting, transcribing and processing multimedia files.

The application combines **yt-dlp**, **FFmpeg** and **OpenAI Whisper** with a modern web interface, background job processing, live logs and system monitoring.

Designed to run locally or on a private server using Docker.

---

# Features

## Media Download

- Download videos, audio and playlists using **yt-dlp**
- Support for multiple media sources
- Background processing queue
- Job history tracking
- Bulk ZIP downloads

## Video Conversion

- Convert videos between:
  - MP4
  - MKV
  - WEBM
  - GIF

- Encoding support:
  - H.264
  - H.265
  - AV1

Additional processing:

- Thumbnail extraction
- Frame extraction
- Audio/video muxing
- Playback speed adjustment

## Audio Processing

- Extract audio tracks from videos
- Convert audio formats:

  - MP3
  - M4A
  - WAV
  - FLAC

## AI Transcription

Powered by **OpenAI Whisper**.

Supported models:

- tiny
- base
- small
- medium
- large-v3

Generated outputs:

- Subtitle files (`.srt`)
- Text transcripts (`.txt`)

## Image Processing

Convert images between:

- JPG
- PNG
- WEBP

---

# Quick Start

## Requirements

Before installing, make sure the following are available:

- Docker
- Docker Compose

---

## Installation

Clone the repository:

```bash
git clone https://github.com/Frxhb/media-converter-selfhosted.git

cd media-converter-selfhosted
```

---

## Configuration

Edit `docker-compose.yml` according to your environment.

Common configuration options:

- exposed port
- mounted directories
- timezone
- container name
- image/build settings

Default directory structure:

```text
media/
├── inputs/
└── outputs/

config/
logs/
```

---

## Start Application

Build and start the container:

```bash
docker compose up --build -d
```

The web interface will be available at:

```text
http://<server-ip>:8080
```

---

# Updating

Pull the latest changes:

```bash
git pull
```

Rebuild the application:

```bash
docker compose up --build -d
```

To completely recreate the environment:

```bash
docker compose down

docker compose up --build -d
```

---

# Directory Structure

| Directory | Description |
|-----------|-------------|
| `media/inputs` | Source files available for processing |
| `media/outputs` | Generated output files |
| `config` | Application configuration and SQLite database |
| `logs` | Application logs |

---

# Architecture

```text
                     Browser
                        |
                        v
                 FastAPI Web UI
                        |
        +---------------+---------------+
        |               |               |
        v               v               v
   Job Queue        FFmpeg          yt-dlp
        |
        v
 Whisper Transcription

```

---

# Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | FastAPI |
| Media Processing | FFmpeg |
| Downloads | yt-dlp |
| AI Transcription | OpenAI Whisper |
| Database | SQLite |
| Containerisation | Docker |
| Communication | WebSockets |

---

# Roadmap

Planned improvements:

- User authentication
- GPU acceleration for Whisper
- Hardware accelerated encoding
- Additional media providers
- Workflow automation
- Cloud storage integrations
- Extended monitoring features

---

# Contributing

Contributions, bug reports and feature requests are welcome.

Please open an issue or submit a pull request.

---

# License

This project is licensed under the MIT License.
