import os
import re
import logging
from logging.handlers import RotatingFileHandler

LOG_DIR = os.getenv("LOG_DIR", "/app/config/logs")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_MAX_BYTES = int(os.getenv("LOG_MAX_BYTES", 5 * 1024 * 1024))  # 5 MB
LOG_BACKUP_COUNT = int(os.getenv("LOG_BACKUP_COUNT", 5))

# Endpunkte, die vom Frontend im Sekundentakt gepollt werden (Job-Queue, Stats,
# Datei-Listen, Config, ...). Erfolgreiche (2xx) GET/HEAD-Anfragen an diese Pfade werden
# aus dem Access-Log gefiltert, sonst gehen echte Ereignisse (gestartete Jobs, Fehler,
# Konfig-Änderungen) in hunderten Polling-Zeilen pro Minute unter. Fehlerhafte Anfragen
# (4xx/5xx) werden UNABHÄNGIG vom Pfad immer geloggt.
POLLING_PATH_PATTERNS = [
    re.compile(p) for p in [
        r"^/api/jobs(\?|$)",
        r"^/api/stats(\?|$)",
        r"^/api/config(\?|$)",
        r"^/api/config/cookies(\?|$)",
        r"^/api/files/(inputs|outputs)(\?|$)",
        r"^/api/subscriptions(\?|$)",
        r"^/api/pipelines(\?|$)",
        r"^/api/system/health(\?|$)",
        r"^/ws(\?|$)",
    ]
]

_ACCESS_LINE_RE = re.compile(r'"(GET|HEAD|POST|PUT|DELETE|PATCH) ([^\s"]+) HTTP/[\d.]+" (\d{3})')

# uvicorn protokolliert WebSocket-Verbindungen NICHT über uvicorn.access, sondern über
# uvicorn.error - mit Zeilen wie '"WebSocket /ws" [accepted]', 'connection open' und
# 'connection closed'. Bei jedem (Re-)Connect eines Browser-Tabs (Seitenreload,
# Server-Neustart, kurzer Netzwerk-Aussetzer + automatischer Reconnect im Frontend)
# entstehen so 2 Zeilen ohne nennenswerten Diagnosewert - werden hier unterdrückt.
# Echte Fehler/Tracebacks auf uvicorn.error matchen diese Muster nicht und bleiben sichtbar.
_WEBSOCKET_NOISE_PATTERNS = [
    re.compile(p) for p in [
        r'"WebSocket [^\s"]+"\s*\[accepted\]',
        r"^connection open$",
        r"^connection closed$",
    ]
]


class PollingAccessFilter(logging.Filter):
    """Unterdrückt erfolgreiche (2xx) uvicorn.access-Zeilen für bekannte Polling-Endpunkte."""

    def filter(self, record: logging.LogRecord) -> bool:
        match = _ACCESS_LINE_RE.search(record.getMessage())
        if not match:
            return True  # unbekanntes Format -> sicherheitshalber nicht unterdrücken
        method, path, status = match.groups()
        if not status.startswith("2") or method != "GET":
            return True  # Fehler und nicht-GET-Requests (Aktionen) immer loggen
        return not any(p.match(path) for p in POLLING_PATH_PATTERNS)


class WebSocketNoiseFilter(logging.Filter):
    """Unterdrückt die routinemäßigen WebSocket-Connect/Disconnect-Zeilen von uvicorn.error
    (siehe oben) - lässt aber alle anderen uvicorn.error-Meldungen (Startup, Tracebacks,
    echte Verbindungsfehler) unangetastet durch."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(p.search(msg) for p in _WEBSOCKET_NOISE_PATTERNS)


class AccessLogRelevanceFilter(logging.Filter):
    """access_handler bekommt Zeilen von uvicorn.access UND (für die WebSocket-Noise-
    Umleitung) von uvicorn.error. Reguläre uvicorn.error-Meldungen wie "Started server
    process" landen bereits über file_handler in app.log - ohne diesen Filter würden sie
    zusätzlich auch im access.log auftauchen. uvicorn.access-Zeilen sind davon nicht
    betroffen, nur echte uvicorn.error-Records ohne WebSocket-Bezug werden hier verworfen."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != "uvicorn.error":
            return True
        return any(p.search(record.getMessage()) for p in _WEBSOCKET_NOISE_PATTERNS)


class AccessLogLevelFilter(logging.Filter):
    """uvicorn protokolliert JEDE Zeile mit logger.info(), unabhängig vom HTTP-Status.
    Damit ein echter 4xx/5xx-Request trotzdem im WARNING-gefilterten error.log auftaucht,
    wird das Level des Records hier anhand des Statuscodes angehoben, bevor er die Handler
    erreicht."""

    def filter(self, record: logging.LogRecord) -> bool:
        match = _ACCESS_LINE_RE.search(record.getMessage())
        if match:
            status = int(match.group(3))
            if status >= 500:
                record.levelno = logging.ERROR
                record.levelname = "ERROR"
            elif status >= 400:
                record.levelno = logging.WARNING
                record.levelname = "WARNING"
        return True


def setup_logging():
    os.makedirs(LOG_DIR, exist_ok=True)
    fmt = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
    formatter = logging.Formatter(fmt, datefmt="%Y-%m-%d %H:%M:%S")

    root = logging.getLogger()
    root.setLevel(LOG_LEVEL)

    # Konsole (docker logs)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(PollingAccessFilter())  # No-op für alle Nicht-Access-Zeilen
    console.addFilter(WebSocketNoiseFilter())  # No-op für alle Nicht-WebSocket-Zeilen
    root.addHandler(console)

    # Rotierende Datei: app.log, app.log.1 ... app.log.5 - NUR für die App-eigenen Logger
    # (Main, JobManager, SubscriptionManager, Database) sowie uvicorns eigene
    # Start-/Fehlermeldungen. uvicorn.access UND die routinemäßigen WebSocket-Connect-Zeilen
    # von uvicorn.error landen bewusst NICHT hier, siehe access_handler weiter unten - sonst
    # geht die eigentliche App-Logik in ständigen Frontend-Pollings/Reconnects unter.
    file_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "app.log"),
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(WebSocketNoiseFilter())  # No-op für alle Nicht-WebSocket-Zeilen
    root.addHandler(file_handler)

    # separates Fehler-Log, um Probleme schnell zu finden ohne app.log zu durchsuchen
    error_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "error.log"),
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    error_handler.setLevel(logging.WARNING)
    error_handler.setFormatter(formatter)
    root.addHandler(error_handler)

    # uvicorn.access (eine Zeile pro HTTP-Request) UND die WebSocket-Connect/Disconnect-
    # Routinezeilen von uvicorn.error bekommen eine EIGENE Datei, damit die ständigen
    # Frontend-Pollings/Reconnects nicht das App-Log überschwemmen. Erfolgreiche
    # Polling-Requests werden zusätzlich komplett herausgefiltert. Echte Fehler (4xx/5xx)
    # landen trotzdem zusätzlich in error.log, dank AccessLogLevelFilter.
    access_handler = RotatingFileHandler(
        os.path.join(LOG_DIR, "access.log"),
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    access_handler.setFormatter(formatter)
    access_handler.addFilter(PollingAccessFilter())  # No-op für Nicht-Access-Zeilen
    access_handler.addFilter(AccessLogRelevanceFilter())

    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers = [access_handler, error_handler, console]
    access_logger.addFilter(AccessLogLevelFilter())
    access_logger.propagate = False

    # uvicorns eigener Start-/Fehler-Logger: "Application startup complete", Absturz-
    # Tracebacks etc. landen normal in app.log/error.log/console. Die WebSocket-Connect/
    # Disconnect-Zeilen werden dort per Filter unterdrückt (siehe file_handler/console oben),
    # aber zusätzlich unverändert ins access_handler geschrieben (ohne dessen
    # PollingAccessFilter, der ja nur auf HTTP-Access-Zeilen passt) - so gehen sie nicht
    # komplett verloren, sondern sind bei Bedarf (z.B. Verdacht auf häufige Reconnects) im
    # Access-Log weiterhin nachvollziehbar.
    uvicorn_error_logger = logging.getLogger("uvicorn.error")
    uvicorn_error_logger.handlers = [console, file_handler, error_handler, access_handler]
    uvicorn_error_logger.propagate = False

    logging.getLogger("uvicorn").handlers = [console, file_handler, error_handler]
    logging.getLogger("uvicorn").propagate = False
