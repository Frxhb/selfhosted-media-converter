const tabQueues = { audio: [], video: [], images: [], tools: [] };
      let currentGroup = "dashboard";
      let activeConvSubTab = "video";
      let activeDlSubTab = "single";
      let activeFileSource = "inputs";
      let outputLibraryFiles = [];
      let activeLibraryCategory = "all";

      let ffmpegWasm = null;
      let useClientFFmpeg =
        localStorage.getItem("mcp_use_client_ffmpeg") === "true";

      let clientJobs = {};
      let serverJobsCache = [];
      let activeLocalJobId = null;

      let pendingDownloadContext = null;
      let configuredMinDiskGb = 2.0;
      let configuredConfirmPlaylist = true;

      let pipelinesCache = [];
      let pipelineEditorStages = []; // aktuell im Editor bearbeitete Stufen (bis zum Speichern)
      let pipelineEditingId = null; // null = neue Pipeline, sonst ID der bearbeiteten Pipeline

      // --- HELPER FÜR DATEITYPEN ---
      const FILE_EXTENSIONS = {
        video: [
          "mp4",
          "mkv",
          "avi",
          "mov",
          "webm",
          "flv",
          "wmv",
          "m4v",
          "mpg",
          "mpeg",
        ],
        audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a", "wma", "opus"],
        images: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"],
      };

      function getFileCategory(filename) {
        const ext = filename.split(".").pop().toLowerCase();
        if (FILE_EXTENSIONS.video.includes(ext)) return "video";
        if (FILE_EXTENSIONS.audio.includes(ext)) return "audio";
        if (FILE_EXTENSIONS.images.includes(ext)) return "image";
        return "unknown";
      }
      async function validateFileStrict(path, expectedCategory) {
        try {
          // Hol die Media-Info vom Server
          const res = await fetch(
            `/api/media-info?file_path=${encodeURIComponent(path)}`,
          );
          const info = await res.json();

          if (!res.ok || !info || !info.streams) return false;

          // --- STRIKTES FILTERN ---
          // Liste von Codecs, die wir als "Bilder" betrachten, auch wenn sie in einem MP4/MKV stecken
          const imageCodecs = ["png", "mjpeg", "bmp", "tiff", "webp", "gif"];

          // 1. Relevante Streams prüfen
          const videoStream = info.streams.find(
            (s) => s.codec_type === "video",
          );

          const hasImageCodec =
            videoStream && imageCodecs.includes(videoStream.codec_name);

          const hasVideoCodec = videoStream && !hasImageCodec;

          const hasAudioCodec = info.streams.some(
            (s) => s.codec_type === "audio",
          );

          // 2. Video-Check
          // Erkennt Videos, die nur ein einzelnes Bild enthalten (z.B. PNG -> MP4)
          const frameCount = videoStream ? Number(videoStream.nb_frames) : 0;

          const duration = videoStream ? Number(videoStream.duration) : 0;

          const isFakeVideo =
            videoStream &&
            (hasImageCodec ||
              frameCount === 1 ||
              (!Number.isNaN(frameCount) && frameCount <= 1) ||
              (!Number.isNaN(duration) && duration <= 0));

          if (expectedCategory === "video" && isFakeVideo) {
            console.warn(
              "Validierung abgelehnt: Datei ist kein echtes Video (Bild/Fake-Video erkannt).",
            );
            return false;
          }

          // Audio darf ebenfalls keine Bilddatei sein
          if (expectedCategory === "audio" && hasImageCodec) {
            console.warn(
              "Validierung abgelehnt: Audio-Datei enthält nur Bild-Stream.",
            );
            return false;
          }

          // 3. Kategorie-Check
          return info.streams.some((s) => {
            if (expectedCategory === "video") {
              // FIX: Erlaubt neben echten Videos nun auch reine Audio-Streams,
              // damit Tools wie Whisper MP3-Dateien nicht fälschlicherweise blockieren.
              return (
                (s.codec_type === "video" && hasVideoCodec && !isFakeVideo) ||
                s.codec_type === "audio"
              );
            }

            if (expectedCategory === "audio") {
              return s.codec_type === "audio" || s.codec_type === "video";
            }

            if (expectedCategory === "image") {
              return s.codec_type === "image" || s.codec_type === "video";
            }

            return true;
          });
        } catch (e) {
          console.error("Validierungsfehler:", e);
          return false;
        }
      }
      const dropzone = document.getElementById("upload-dropzone");
      if (dropzone) {
        ["dragenter", "dragover"].forEach((name) => {
          dropzone.addEventListener(
            name,
            (e) => {
              e.preventDefault();
              dropzone.classList.add("dragover");
            },
            false,
          );
        });
        ["dragleave", "drop"].forEach((name) => {
          dropzone.addEventListener(
            name,
            (e) => {
              e.preventDefault();
              dropzone.classList.remove("dragover");
            },
            false,
          );
        });
        dropzone.addEventListener("drop", (e) => {
          const dt = e.dataTransfer;
          if (dt.files && dt.files.length > 0) {
            document.getElementById("global-file-upload").files = dt.files;
            uploadSelectedFileWithProgress();
          }
        });
      }

      function switchFileSource(source) {
        activeFileSource = source;
        document
          .getElementById("src-btn-inputs")
          .classList.toggle("active", source === "inputs");
        document
          .getElementById("src-btn-outputs")
          .classList.toggle("active", source === "outputs");
        document.getElementById("file-select-label").textContent =
          source === "outputs"
            ? "Datei aus /media/outputs wählen:"
            : "Datei aus /media/inputs wählen:";
        refreshFiles();
      }

      function cancelClientJob(jobId) {
        const job = clientJobs[jobId];
        if (job) {
          job.status = "cancelled";
          job.eta = t("label.cancelled");
          appendLog(
            `[Client-FFmpeg] Job ${jobId} (${job.title}) manuell abgebrochen.`,
          );
          if (ffmpegWasm) {
            try {
              ffmpegWasm.terminate();
              ffmpegWasm = null;
            } catch (e) {}
          }
          renderJobsCombined();
        }
      }

      async function initFFmpegWasm() {
        try {
          const { FFmpeg } = window.FFmpegWASM || {};
          if (!FFmpeg) throw new Error("FFmpegWASM nicht verfügbar.");

          const getBlobURL = async function (url, mimeType) {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();
            return URL.createObjectURL(new Blob([buf], { type: mimeType }));
          };

          ffmpegWasm = new FFmpeg();
          ffmpegWasm.on("log", ({ message }) => {
            if (
              message.includes("Last message repeated") ||
              message.includes("Missing Sequence Header")
            )
              return;
            appendLog(`[Client-FFmpeg] ${message}`);
          });

          ffmpegWasm.on("progress", ({ progress }) => {
            const pct = Math.min(99.9, Math.round(progress * 1000) / 10);
            if (activeLocalJobId && clientJobs[activeLocalJobId]) {
              clientJobs[activeLocalJobId].progress = pct;
              clientJobs[activeLocalJobId].eta = `${pct}% (CPU)`;
              renderJobsCombined();
            }
          });

          const baseURL = window.location.origin + "/static/vendor/ffmpeg";
          const coreURL = await getBlobURL(
            `${baseURL}/ffmpeg-core.js`,
            "text/javascript",
          );
          const wasmURL = await getBlobURL(
            `${baseURL}/ffmpeg-core.wasm`,
            "application/wasm",
          );

          await ffmpegWasm.load({ coreURL, wasmURL });
          appendLog(`[WASM] ${t("label.wasm_ready")}`);
        } catch (e) {
          appendLog(`[WASM ERROR] ${e.message}`);
        }
      }

      function sanitizeUrl(raw) {
        return (raw || "").replace(/\s+/g, "").trim();
      }

      function isLikelyValidUrl(str) {
        if (!str) return false;
        try {
          const parsed = new URL(str);
          return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch (e) {
          return false;
        }
      }

      /* ---------- PRIORITY SLIDER ---------- */
      // WICHTIG: t() hier NICHT in eine einmalig gebaute Konstante schreiben - diese
      // Datei läuft synchron beim Parsen der Seite, BEVOR i18n.js auf "DOMContentLoaded"
      // die Übersetzungen nachlädt. Ein t()-Aufruf an dieser Stelle würde für immer den
      // rohen Übersetzungsschlüssel (z.B. "settings.priority_hint_high") statt des Textes
      // zwischenspeichern. Stattdessen wird bei jeder Anzeige live nachgeschlagen.
      function getPriorityHint(value) {
        const key = {
          low: "settings.priority_hint_low",
          below_normal: "settings.priority_hint_below_normal",
          high: "settings.priority_hint_high",
        }[value] || "settings.priority_hint_below_normal";
        return t(key);
      }
      const PRIORITY_SLOT_INDEX = { low: 0, below_normal: 1, high: 2 };
      const PRIORITY_ICONS = { low: "🐢", below_normal: "⚖️", high: "⚡" };

      function setPrioritySlider(value) {
        document.getElementById("cfg-process-priority").value = value;

        document.querySelectorAll(".priority-option").forEach((el) => {
          el.classList.toggle(
            "active",
            el.getAttribute("data-value") === value,
          );
        });

        const thumb = document.getElementById("priority-thumb");
        const slot = PRIORITY_SLOT_INDEX[value] ?? 1;
        thumb.style.transform = `translateX(${slot * 100}%)`;

        const hintEl = document.getElementById("priority-hint");
        hintEl.innerHTML = `<span class="priority-hint-icon">${PRIORITY_ICONS[value] || PRIORITY_ICONS.below_normal}</span><span>${escapeHtml(getPriorityHint(value))}</span>`;
      }

      function normalizePriorityForSlider(rawValue) {
        if (rawValue === "low") return "low";
        if (rawValue === "high" || rawValue === "above_normal") return "high";
        return "below_normal";
      }

      function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str ?? "";
        return div.innerHTML;
      }

      /* ---------- WHISPER HELPER ---------- */
      function toggleWhisperCustomLang(selectId, inputId) {
        const selectEl = document.getElementById(selectId);
        const inputEl = document.getElementById(inputId);
        if (selectEl && inputEl) {
          if (selectEl.value === "custom") {
            inputEl.style.display = "inline-block";
            inputEl.focus();
          } else {
            inputEl.style.display = "none";
            inputEl.value = "";
          }
        }
      }

      /* ---------- FULL THEME PRESETS (Hintergrund/Oberflächen, unabhängig von der Akzentfarbe) ----------
         Jedes Preset hat eine dark- und eine light-Variante, damit der Dunkel/Hell-Umschalter
         oben auch bei aktivem Farbschema weiterhin sichtbar etwas bewirkt. */
      const THEME_PRESETS = {
        nord: {
          dark: {
            bg: "#2e3440", surface: "#3b4252", surfaceRaised: "#434c5e", surfaceSunken: "#272c36",
            line: "#4c566a", lineSoft: "#434c5e", ink: "#eceff4", inkDim: "#9aa5b1", inkFaint: "#616e81",
          },
          light: {
            bg: "#e5e9f0", surface: "#eceff4", surfaceRaised: "#f7f9fc", surfaceSunken: "#d8dee9",
            line: "#c8d0e0", lineSoft: "#d8dee9", ink: "#2e3440", inkDim: "#4c566a", inkFaint: "#8390a8",
          },
        },
        solarized: {
          dark: {
            bg: "#002b36", surface: "#073642", surfaceRaised: "#0a3f4d", surfaceSunken: "#00212b",
            line: "#0d4956", lineSoft: "#0a3f4d", ink: "#eee8d5", inkDim: "#93a1a1", inkFaint: "#586e75",
          },
          light: {
            bg: "#fdf6e3", surface: "#eee8d5", surfaceRaised: "#fffaf0", surfaceSunken: "#e5decc",
            line: "#d3cbb7", lineSoft: "#e0d8c3", ink: "#073642", inkDim: "#586e75", inkFaint: "#93a1a1",
          },
        },
        sepia: {
          dark: {
            bg: "#2b2318", surface: "#372d1e", surfaceRaised: "#413524", surfaceSunken: "#231c13",
            line: "#4a3d29", lineSoft: "#3f331f", ink: "#f0e6cf", inkDim: "#c2b193", inkFaint: "#8a795c",
          },
          light: {
            bg: "#f4ecd8", surface: "#fbf6ea", surfaceRaised: "#fffdf8", surfaceSunken: "#ece0c4",
            line: "#ddccA0", lineSoft: "#e6d9b8", ink: "#3b2f1e", inkDim: "#6b5c42", inkFaint: "#a08e68",
          },
        },
        midnight: {
          dark: {
            bg: "#0a0e1a", surface: "#121828", surfaceRaised: "#1a2236", surfaceSunken: "#070a12",
            line: "#232c42", lineSoft: "#1c2338", ink: "#e6eaf5", inkDim: "#8891a8", inkFaint: "#4d5670",
          },
          light: {
            bg: "#eef1f8", surface: "#f7f9fd", surfaceRaised: "#ffffff", surfaceSunken: "#e2e7f2",
            line: "#cbd4e6", lineSoft: "#dde3f0", ink: "#141a2c", inkDim: "#3f4a68", inkFaint: "#7885a3",
          },
        },
        forest: {
          dark: {
            bg: "#0d1512", surface: "#16211c", surfaceRaised: "#1d2b24", surfaceSunken: "#0a100d",
            line: "#2a3a32", lineSoft: "#223129", ink: "#e8f0ea", inkDim: "#8ba398", inkFaint: "#4f6358",
          },
          light: {
            bg: "#eef3ee", surface: "#f6faf6", surfaceRaised: "#ffffff", surfaceSunken: "#e2ebe2",
            line: "#c9d8c9", lineSoft: "#dbe7db", ink: "#132018", inkDim: "#41564a", inkFaint: "#728a78",
          },
        },
        oled: {
          dark: {
            bg: "#000000", surface: "#0a0a0a", surfaceRaised: "#131313", surfaceSunken: "#000000",
            line: "#232323", lineSoft: "#1a1a1a", ink: "#f5f5f5", inkDim: "#969696", inkFaint: "#555555",
          },
          light: {
            bg: "#ffffff", surface: "#fafafa", surfaceRaised: "#ffffff", surfaceSunken: "#f0f0f0",
            line: "#e0e0e0", lineSoft: "#ececec", ink: "#000000", inkDim: "#3a3a3a", inkFaint: "#7a7a7a",
          },
        },
      };
      const THEME_PRESET_VAR_MAP = {
        bg: "--bg", surface: "--surface", surfaceRaised: "--surface-raised", surfaceSunken: "--surface-sunken",
        line: "--line", lineSoft: "--line-soft", ink: "--ink", inkDim: "--ink-dim", inkFaint: "--ink-faint",
      };

      function applyActiveThemePreset(resolvedLight) {
        const name = localStorage.getItem("mcp_theme_preset") || "default";
        if (name === "default" || !THEME_PRESETS[name]) {
          Object.values(THEME_PRESET_VAR_MAP).forEach((cssVar) =>
            document.body.style.removeProperty(cssVar),
          );
          return;
        }
        const variant = THEME_PRESETS[name][resolvedLight ? "light" : "dark"];
        Object.entries(THEME_PRESET_VAR_MAP).forEach(([key, cssVar]) =>
          document.body.style.setProperty(cssVar, variant[key]),
        );
      }

      function setThemePreset(name) {
        if (name === "default" || !THEME_PRESETS[name]) {
          localStorage.removeItem("mcp_theme_preset");
        } else {
          localStorage.setItem("mcp_theme_preset", name);
        }
        const mode = localStorage.getItem("mcp_theme_mode") || "dark";
        applyActiveThemePreset(resolveIsLight(mode));
        document.querySelectorAll(".theme-swatch").forEach((swatch) => {
          swatch.classList.toggle(
            "active",
            swatch.dataset.themePreset === (name || "default"),
          );
        });
      }
      // Preset wird bereits über applyThemeMode()/initTheme() oben mit angewendet (liest
      // "mcp_theme_preset" selbst aus localStorage) - hier nur noch die aktive Kachel markieren.
      document.querySelectorAll(".theme-swatch").forEach((swatch) => {
        swatch.classList.toggle(
          "active",
          swatch.dataset.themePreset === (localStorage.getItem("mcp_theme_preset") || "default"),
        );
      });

      /* ---------- THEME MODE ---------- */
      const themeIcons = {
        dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 0 1 8.646 3.646 9.003 9.003 0 0 0 12 21a9.003 9.003 0 0 0 8.354-5.646z"/></svg>',
        light:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
        system:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
      };

      function resolveIsLight(mode) {
        const prefersDark =
          window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: dark)").matches;
        return mode === "light" || (mode === "system" && !prefersDark);
      }

      function applyThemeMode(mode) {
        const resolvedLight = resolveIsLight(mode);
        document.body.classList.toggle("light-mode", resolvedLight);

        const btn = document.getElementById("theme-toggle-btn");
        if (btn) {
          btn.innerHTML = themeIcons[mode];
          const labels = {
            dark: t("label.theme_dark"),
            light: t("label.theme_light"),
            system: t("label.theme_system"),
          };
          btn.title = t("label.theme_toggle_hint").replace("{mode}", labels[mode]);
        }

        // Ist gerade ein volles Farbschema (Nord, Solarized, ...) aktiv, muss dessen
        // passende Dunkel-/Hell-Variante erneut angewendet werden - sonst hätte der
        // Umschalter hier keine sichtbare Wirkung, weil die Preset-Werte als Inline-Style
        // ohnehin über die .light-mode Klasse gewinnen (siehe applyActiveThemePreset).
        applyActiveThemePreset(resolvedLight);
      }

      function toggleTheme() {
        const order = ["dark", "light", "system"];
        const current = localStorage.getItem("mcp_theme_mode") || "dark";
        const next = order[(order.indexOf(current) + 1) % order.length];
        localStorage.setItem("mcp_theme_mode", next);
        applyThemeMode(next);
      }

      (function initTheme() {
        const saved =
          localStorage.getItem("mcp_theme_mode") ||
          (localStorage.getItem("mcp_theme") === "light" ? "light" : null) ||
          "dark";
        applyThemeMode(saved);
        if (window.matchMedia) {
          window
            .matchMedia("(prefers-color-scheme: dark)")
            .addEventListener("change", () => {
              if (
                (localStorage.getItem("mcp_theme_mode") || "dark") === "system"
              )
                applyThemeMode("system");
            });
        }
      })();

      function setThemeAccent(color) {
        document.body.style.setProperty("--signal", color);
        document.body.style.setProperty("--signal-dim", color + "24");
        localStorage.setItem("mcp_accent", color);
        document.querySelectorAll(".color-dot").forEach((dot) => {
          dot.classList.toggle("active", dot.dataset.accent === color);
        });
      }
      const savedAccent = localStorage.getItem("mcp_accent");
      if (savedAccent) setThemeAccent(savedAccent);

      function setConnectionStatus(state) {
        const el = document.getElementById("ws-status");
        const label = document.getElementById("ws-status-label");
        if (!el || !label) return;
        el.classList.remove("online", "busy", "offline");
        el.classList.add(state);
        label.textContent =
          state === "busy"
            ? t("label.overloaded")
            : state === "online"
              ? t("app.status_online")
              : t("app.status_offline");
      }

      const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
      let ws = null;
      let wsReconnectAttempts = 0;
      let wsReconnectTimer = null;

      function connectWebSocket() {
        ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);

        ws.onopen = () => {
          wsReconnectAttempts = 0;
          setConnectionStatus("online");

          loadJobs();
          refreshFiles();
          fetchStats();
          loadServerConfig();
          updateDownloadQualityOptions();
        };

        ws.onclose = () => {
          setConnectionStatus("offline");
          // Ohne automatischen Reconnect blieb der Status nach kurzen Netzwerk-Aussetzern,
          // Proxy-Timeouts oder Tab-Standby dauerhaft auf OFFLINE stehen, bis der Nutzer die
          // Seite manuell neu geladen hat. Exponentielles Backoff (max. 15s), damit bei einem
          // Server-Neustart nicht unnötig oft in kurzer Folge versucht wird.
          const delay = Math.min(1000 * Math.pow(1.5, wsReconnectAttempts), 15000);
          wsReconnectAttempts++;
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = setTimeout(connectWebSocket, delay);
        };

        ws.onerror = () => {
          ws.close();
        };

        ws.onmessage = handleWsMessage;
      }

      function handleWsMessage(event) {
        const data = JSON.parse(event.data);
        if (data.type === "job_created" || data.type === "job_updated") {
          loadJobs();
          refreshOutputFiles();
          fetchStats();
        } else if (data.type === "log") {
          appendLog(data.line);
          if (data.job_id) {
            const j = serverJobsCache.find((x) => x.id === data.job_id);
            if (j) {
              if (!j.logs) j.logs = [];
              j.logs.push(data.line);
            }
          }
        } else if (data.type === "job_progress") {
          updateJobProgressUI(
            data.job_id,
            data.progress,
            data.eta,
            data.log_line,
          );
          const j = serverJobsCache.find((x) => x.id === data.job_id);
          if (j) {
            j.progress = data.progress;
            j.eta = data.eta;
            if (data.log_line) {
              if (!j.logs) j.logs = [];
              j.logs.push(data.log_line);
            }
          }
          if (data.log_line) {
            appendLog(data.log_line);
            // FIX: Live-Updates im Job-Details Modal anzeigen und mitscrollen
            const detailsModal = document.getElementById("job-details-modal");
            const detailsLogEl = document.getElementById("job-details-logs");
            const detailsMetaEl = document.getElementById("job-details-meta");

            if (detailsModal && detailsModal.classList.contains("active")) {
              const header =
                document.getElementById("job-details-header").textContent;
              if (j && header.includes(j.title)) {
                // Update the text logs
                if (detailsLogEl) {
                  detailsLogEl.textContent +=
                    (detailsLogEl.textContent ? "\n" : "") + data.log_line;
                  detailsLogEl.scrollTop = detailsLogEl.scrollHeight;
                }

                // NEU: Update die Meta-Leiste (ID, Modus, Status, Fortschritt)
                if (detailsMetaEl) {
                  let plInfo = "";
                  if (j.is_playlist && j.playlist_index && j.playlist_count) {
                    plInfo = ` | <strong>Playlist:</strong> Video ${j.playlist_index} von ${j.playlist_count}`;
                  }
                  const processingMode =
                    j.id && j.id.startsWith("local_")
                      ? "Client (WASM)"
                      : "Server";

                  detailsMetaEl.innerHTML = `
                            <strong>ID:</strong> ${j.id} | <strong>Modus:</strong> ${processingMode} | <strong>Tool:</strong> ${j.tool} | <strong>Status:</strong> ${j.status.toUpperCase()} | <strong>Fortschritt:</strong> ${data.progress}%${plInfo}
                        `;
                }
              }
            }
          }
        } else if (data.type === "queue_reordered") {
          loadJobs();
        }
      }

      connectWebSocket();

      const LOG_CONSOLE_MAX_LINES = 2000;

      function appendLog(msg) {
        const consoleEl = document.getElementById("log-console");
        consoleEl.textContent += msg + "\n";
        // Begrenzung, damit bei großen Batch-Downloads (viele Zeilen Fortschrittsausgabe)
        // die Textbox nicht unbegrenzt wächst und der Browser-Tab langsam wird. Die volle,
        // unbegrenzte Ausgabe landet trotzdem im Server-Logfile (app.log), abrufbar über
        // /api/logs bzw. den Log-Viewer in den Einstellungen.
        const lines = consoleEl.textContent.split("\n");
        if (lines.length > LOG_CONSOLE_MAX_LINES) {
          consoleEl.textContent = lines.slice(lines.length - LOG_CONSOLE_MAX_LINES).join("\n");
        }
        const autoScroll = document.getElementById("log-autoscroll");
        if (!autoScroll || autoScroll.checked) {
          consoleEl.scrollTop = consoleEl.scrollHeight;
        }
      }

      async function copyLogToClipboard() {
        const consoleEl = document.getElementById("log-console");
        const text = consoleEl ? consoleEl.textContent : "";
        if (!text) return showToast(t("toast.log_empty"), "warn");
        try {
          await navigator.clipboard.writeText(text);
          showToast(t("toast.log_copied"), "success");
        } catch (e) {
          try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            showToast(t("toast.log_copied"), "success");
          } catch (e2) {
            showToast(t("toast.copy_not_supported"), "warn");
          }
        }
      }

      function showToast(message, type = "info", durationMs = 4200) {
        let container = document.getElementById("toast-container");
        if (!container) {
          container = document.createElement("div");
          container.id = "toast-container";
          document.body.appendChild(container);
        }

        const icons = {
          success:
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
          info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
          warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        };

        const toast = document.createElement("div");
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg"></span><button class="toast-close" aria-label="${t('common.close')}">✕</button>`;
        toast.querySelector(".toast-msg").textContent = message;
        toast.querySelector(".toast-close").onclick = () => dismissToast(toast);

        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add("visible"));

        const timer = setTimeout(() => dismissToast(toast), durationMs);
        toast._timer = timer;
      }
