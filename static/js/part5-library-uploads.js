function removeFromTabQueue(tab, index) {
        tabQueues[tab].splice(index, 1);
        renderTabQueue(tab);
        updateAllPreviews();
      }

      function clearTabQueue(tab) {
        tabQueues[tab] = [];
        renderTabQueue(tab);
        updateAllPreviews();
      }

      async function addSelectedFileToActiveQueue() {
        const select = document.getElementById("global-file-select");
        const path = select.value;
        if (!path) return showToast("Wähle eine Datei aus.", "warn");

        // Bestimme den erwarteten Typ für den aktuellen Tab
        let expectedType = "video"; // Default
        if (activeConvSubTab === "audio") expectedType = "audio";
        if (activeConvSubTab === "images") expectedType = "image";

        showToast("Prüfe Datei-Integrität...", "info", 1500);

        // Strikte Validierung
        const isValid = await validateFileStrict(path, expectedType);

        if (!isValid) {
          // Hier geben wir dem User die Info, dass es am Format liegt
          showToast(
            `⚠️ Datei abgelehnt: Datei ist kein valider ${expectedType.toUpperCase()}-Typ oder beschädigt.`,
            "danger",
            6000,
          );
          return;
        }

        const fullText = select.options[select.selectedIndex].text;
        const name = fullText.replace(/\s+\(\d+(\.\d+)?\s*MB\)$/i, "");

        if (currentGroup === "special") {
          const whisperSelect = document.getElementById("sp-whisper-file");
          if (whisperSelect) whisperSelect.value = path;
          return;
        }

        addFileToQueue(activeConvSubTab, {
          name: name,
          path: path,
          size_mb: "",
        });
        showToast("Datei hinzugefügt.", "success");
      }

      let currentUploadXhr = null;

      function cancelFileUpload() {
        if (currentUploadXhr) {
          currentUploadXhr.abort();
          currentUploadXhr = null;
        }
      }

      function uploadSelectedFileWithProgress() {
        const input = document.getElementById("global-file-upload");
        if (!input.files || input.files.length === 0) return;

        const file = input.files[0];
        const fileSizeMb = (file.size / (1024 * 1024)).toFixed(2);

        const wrapper = document.getElementById("upload-progress-wrapper");
        const fill = document.getElementById("upload-progress-fill");
        const statusText = document.getElementById("upload-status-text");
        const cancelBtn = document.getElementById("upload-cancel-btn");

        wrapper.style.display = "block";
        if (cancelBtn) cancelBtn.style.display = "inline-block";
        fill.style.width = "0%";
        fill.className = "meter-fill";
        statusText.style.color = "var(--ink-dim)";
        statusText.textContent = `Starte Upload (${fileSizeMb} MB)...`;

        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        currentUploadXhr = xhr;

        xhr.open("POST", "/api/files/upload", true);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            const loadedMb = (e.loaded / (1024 * 1024)).toFixed(2);
            fill.style.width = `${pct}%`;
            statusText.textContent = `Upload läuft: ${pct}% (${loadedMb} / ${fileSizeMb} MB)`;
          }
        };

        xhr.onabort = () => {
          currentUploadXhr = null;
          if (cancelBtn) cancelBtn.style.display = "none";
          fill.classList.add("warn-fill");
          statusText.style.color = "var(--warn)";
          statusText.textContent = "⚠️ Upload abgebrochen.";
          showToast("Upload abgebrochen.", "info");

          setTimeout(() => {
            wrapper.style.display = "none";
            fill.classList.remove("warn-fill");
            statusText.textContent = "";
            input.value = "";
          }, 2000);
        };

        xhr.onload = async () => {
          currentUploadXhr = null;
          if (cancelBtn) cancelBtn.style.display = "none";

          if (xhr.status === 200) {
            fill.style.width = "100%";
            fill.classList.add("ok-fill");
            statusText.textContent = "✅ Upload erfolgreich!";
            showToast(`Datei "${file.name}" hochgeladen.`, "success");

            const res = JSON.parse(xhr.responseText);
            await refreshFiles();
            addFileToQueue(activeConvSubTab, {
              name: res.filename,
              path: res.path,
              size_mb: res.size_mb,
            });

            setTimeout(() => {
              wrapper.style.display = "none";
              fill.classList.remove("ok-fill");
              statusText.textContent = "";
              input.value = "";
            }, 2500);
          } else {
            let errDetail = `HTTP ${xhr.status}`;
            try {
              const res = JSON.parse(xhr.responseText);
              if (res.detail) errDetail = res.detail;
            } catch (e) {}

            fill.classList.add("danger-fill");
            statusText.style.color = "var(--danger)";
            statusText.textContent = `❌ ${errDetail}`;
            showToast(`Upload fehlgeschlagen: ${errDetail}`, "warn", 7000);

            setTimeout(() => {
              wrapper.style.display = "none";
              fill.classList.remove("danger-fill");
            }, 4000);
          }
        };

        xhr.onerror = () => {
          currentUploadXhr = null;
          if (cancelBtn) cancelBtn.style.display = "none";
          fill.classList.add("danger-fill");
          statusText.style.color = "var(--danger)";
          statusText.textContent = "❌ Netzwerkfehler beim Upload.";
          showToast("Netzwerkfehler beim Upload.", "warn");
        };

        xhr.send(formData);
      }

      async function resetGuiAndRefresh() {
        try {
          await clearCompletedServerJobs();
        } catch (e) {}

        const consoleEl = document.getElementById("log-console");
        if (consoleEl) consoleEl.textContent = "";

        ["audio", "video", "images"].forEach((tab) => {
          tabQueues[tab] = [];
          renderTabQueue(tab);
        });

        const inputsToReset = [
          "d-url",
          "d-batch-textarea",
          "job-search",
          "lib-search",
          "pl-run-url",
          "v-custom-title",
          "a-custom-title",
          "v-trim-start",
          "v-trim-end",
          "d-custom-flags",
        ];
        inputsToReset.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = "";
        });

        const previewEl = document.getElementById("d-info-preview");
        if (previewEl) previewEl.style.display = "none";

        const libSelectAll = document.getElementById("lib-select-all");
        if (libSelectAll) {
          libSelectAll.checked = false;
          toggleSelectAllLibraryItems(false);
        }

        updateAllPreviews();
        await refreshFiles();
        await fetchStats();
        await loadJobs();

        showToast("UI & Warteschlange zurückgesetzt.", "success", 2000);
      }

      async function refreshFiles() {
        try {
          const res = await fetch(
            `/api/files/inputs?source=${activeFileSource}`,
          );
          const allFiles = await res.json();

          // 1. Kategorien-Filter bestimmen: IMMER filtern, wenn wir in den Konverter-Tabs sind
          const allowed = [];
          // Wenn wir "Verarbeiten" (converter) offen haben ODER beim ersten Laden (Standard)
          if (currentGroup === "converter" || currentGroup === "dashboard") {
            if (activeConvSubTab === "video") allowed.push("video");
            else if (activeConvSubTab === "audio")
              allowed.push("audio", "video");
            else if (activeConvSubTab === "images") allowed.push("image");
            else if (
              activeConvSubTab === "tools" ||
              activeConvSubTab === "muxing"
            )
              allowed.push("video", "audio");
            else allowed.push("video", "audio", "image");
          } else {
            allowed.push("video", "audio", "image");
          }

          // 2. DOM-Elemente abrufen
          const select = document.getElementById("global-file-select");
          const muxVid = document.getElementById("m-video-select");
          const muxAud = document.getElementById("m-audio-select");
          const batchDl = document.getElementById("d-batch-select");
          const whisperSelect = document.getElementById("sp-whisper-file");

          // 3. Dropdowns zurücksetzen
          select.innerHTML = '<option value="">-- Datei wählen --</option>';
          muxVid.innerHTML = '<option value="">-- Video wählen --</option>';
          muxAud.innerHTML = '<option value="">-- Audio wählen --</option>';
          batchDl.innerHTML =
            '<option value="">-- .txt Datei wählen --</option>';
          whisperSelect.innerHTML =
            '<option value="">-- Datei wählen --</option>';

          // 4. Dateien verarbeiten und filtern
          allFiles.forEach((f) => {
            const cat = getFileCategory(f.name);
            const opt = `<option value="${escapeHtml(f.path)}">${escapeHtml(f.name)} (${f.size_mb} MB)</option>`;

            // Haupt-Dropdown: Nur erlaubte Kategorien für diesen Tab
            if (allowed.includes(cat)) {
              select.innerHTML += opt;
            }

            // Spezial-Dropdowns: Diese benötigen spezifische Typen
            if (cat === "video") muxVid.innerHTML += opt;
            if (cat === "audio") muxAud.innerHTML += opt;

            // Batch & Whisper (behalten wir etwas offener)
            if (f.name.endsWith(".txt")) batchDl.innerHTML += opt;
            whisperSelect.innerHTML += opt;
          });

          refreshOutputFiles();
        } catch (e) {
          console.error("Fehler beim Laden der Dateien:", e);
          showToast("Fehler beim Laden der Dateiliste.", "warn");
        }
      }

      async function checkSimilarBeforeSubmit(inputFile) {
        try {
          const res = await fetch(
            `/api/jobs/check-similar?file_path=${encodeURIComponent(inputFile)}`,
          );
          if (!res.ok) return [];
          const data = await res.json();
          return data.matches || [];
        } catch (e) {
          return [];
        }
      }

      async function submitJob(payload, force = false) {
        if (!force && payload.job_type !== "download" && payload.input_file) {
          const similar = await checkSimilarBeforeSubmit(payload.input_file);
          if (similar.length > 0) {
            const names = similar
              .slice(0, 3)
              .map((m) => `• ${m.title} (${m.size_mb} MB)`)
              .join("\n");
            const proceed = confirm(
              `Möglicherweise bereits verarbeitet - ähnliche Datei(en) in der Historie gefunden:\n\n${names}\n\nTrotzdem fortfahren?`,
            );
            if (!proceed) return;
          }
        }

        try {
          const url = force ? "/api/jobs?force=true" : "/api/jobs";
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const detail = err.detail || `HTTP ${res.status}`;
            if (
              res.status === 409 &&
              detail.includes("Ein identischer Job") &&
              !force
            ) {
              if (confirm(`${detail}\n\nTrotzdem erneut starten?`)) {
                return submitJob(payload, true);
              }
              return;
            }
            showToast(`Job nicht gestartet: ${detail}`, "warn", 7000);
            appendLog(
              `[FEHLER] Job "${payload.title || payload.job_type}" nicht gestartet: ${detail}`,
            );
            return;
          }

          const job = await res.json();
          appendLog(`[SYSTEM] Job ${job.id} gestartet.`);
          showToast(`Job "${job.title}" gestartet.`, "success");
          loadJobs();
        } catch (e) {
          showToast("Fehler: " + e.message, "warn");
        }
      }

      async function loadServerConfig() {
        try {
          const res = await fetch("/api/config");
          const cfg = await res.json();
          document.getElementById("cfg-max-jobs").value =
            cfg.max_concurrent_jobs;
          document.getElementById("cfg-cleanup-days").value =
            cfg.auto_cleanup_days;
          document.getElementById("cfg-client-ffmpeg").checked =
            useClientFFmpeg;
          document.getElementById("cfg-push-enabled").checked =
            cfg.pushover_enabled;
          document.getElementById("cfg-push-user").value =
            cfg.pushover_user_key || "";
          document.getElementById("cfg-push-token").value =
            cfg.pushover_token || "";

          document.getElementById("cfg-min-disk-gb").value =
            cfg.min_free_disk_gb ?? 2.0;
          document.getElementById("cfg-prevent-overwrite").checked =
            cfg.prevent_output_overwrite !== false;
          document.getElementById("cfg-confirm-playlist").checked =
            cfg.confirm_full_playlist_downloads !== false;
          document.getElementById("cfg-max-per-domain").value =
            cfg.max_concurrent_per_domain ?? 2;
          document.getElementById("cfg-ffmpeg-threads").value =
            cfg.ffmpeg_threads || "Auto";
          setPrioritySlider(
            normalizePriorityForSlider(cfg.process_priority || "below_normal"),
          );
          document.getElementById("cfg-auto-delete-originals").checked =
            !!cfg.auto_delete_originals;

          const badge = document.getElementById("config-source-badge");
          if (badge) {
            if (cfg.config_source === "saved") {
              badge.textContent = "Gespeicherte Einstellungen aktiv";
              badge.title =
                "Diese Werte kommen aus der gespeicherten Konfiguration und überschreiben .env bei jedem Start.";
            } else {
              badge.textContent = ".env Defaults (noch nicht gespeichert)";
              badge.title =
                "Noch keine gespeicherte Konfiguration vorhanden - diese Werte stammen aus der .env. Sobald du speicherst, gewinnt ab dann immer die gespeicherte Version, auch nach Neustarts.";
            }
          }

          configuredMinDiskGb = cfg.min_free_disk_gb ?? 2.0;
          configuredConfirmPlaylist =
            cfg.confirm_full_playlist_downloads !== false;
        } catch (e) {}
        loadCookiesStatus();
      }

      async function saveServerConfig() {
        const isClientFFmpeg =
          document.getElementById("cfg-client-ffmpeg").checked;

        useClientFFmpeg = isClientFFmpeg;
        localStorage.setItem(
          "mcp_use_client_ffmpeg",
          isClientFFmpeg ? "true" : "false",
        );
        if (isClientFFmpeg && !ffmpegWasm) {
          initFFmpegWasm();
        }

        const payload = {
          max_concurrent_jobs:
            parseInt(document.getElementById("cfg-max-jobs").value) || 2,
          auto_cleanup_days:
            parseInt(document.getElementById("cfg-cleanup-days").value) || 0,
          pushover_enabled: document.getElementById("cfg-push-enabled").checked,
          pushover_user_key: document.getElementById("cfg-push-user").value,
          pushover_token: document.getElementById("cfg-push-token").value,
          min_free_disk_gb:
            parseFloat(document.getElementById("cfg-min-disk-gb").value) || 0,
          prevent_output_overwrite: document.getElementById(
            "cfg-prevent-overwrite",
          ).checked,
          confirm_full_playlist_downloads: document.getElementById(
            "cfg-confirm-playlist",
          ).checked,
          max_concurrent_per_domain:
            parseInt(document.getElementById("cfg-max-per-domain").value) || 0,
          ffmpeg_threads: document.getElementById("cfg-ffmpeg-threads").value,
          process_priority: document.getElementById("cfg-process-priority")
            .value,
          auto_delete_originals: document.getElementById(
            "cfg-auto-delete-originals",
          ).checked,
        };

        const btn = document.getElementById("btn-save-settings");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Speichere...";

        try {
          const res = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
              err.detail || `Fehler beim Speichern (HTTP ${res.status})`,
            );
          }

          configuredMinDiskGb = payload.min_free_disk_gb;
          configuredConfirmPlaylist = payload.confirm_full_playlist_downloads;

          showToast("Einstellungen gespeichert.", "success");
          closeModal("settings-modal");
        } catch (e) {
          showToast(
            "Einstellungen konnten nicht gespeichert werden: " + e.message,
            "warn",
            7000,
          );
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      async function loadYtDlpVersion() {
        const el = document.getElementById("ytdlp-version-display");
        if (!el) return;
        el.textContent = "wird geladen...";
        try {
          const res = await fetch("/api/system/ytdlp-version");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          el.textContent = data.version || "unbekannt";
        } catch (e) {
          el.textContent = "Fehler: " + e.message;
        }
      }

      async function checkAndUpdateYtDlp() {
        const btn = document.getElementById("btn-ytdlp-update");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Prüfe & aktualisiere...";
        try {
          const res = await fetch("/api/system/ytdlp-update", {
            method: "POST",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
          document.getElementById("ytdlp-version-display").textContent =
            data.version || "unbekannt";
          showToast(
            `yt-dlp aktualisiert: ${data.version || ""}`.trim(),
            "success",
          );
        } catch (e) {
          showToast("yt-dlp Update fehlgeschlagen: " + e.message, "warn", 7000);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      async function restoreConfigBackup() {
        const input = document.getElementById("config-restore-input");
        const file = input.files[0];
        if (!file) return;
        if (
          !confirm(
            "Aktuelle Einstellungen und Job-Historie werden überschrieben. Fortfahren?",
          )
        ) {
          input.value = "";
          return;
        }

        const formData = new FormData();
        formData.append("file", file);

        try {
          const res = await fetch("/api/config/restore", {
            method: "POST",
            body: formData,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
          showToast(
            data.detail || "Backup wiederhergestellt.",
            "success",
            7000,
          );
          loadServerConfig();
          fetchStats();
        } catch (e) {
          showToast(
            "Wiederherstellung fehlgeschlagen: " + e.message,
            "warn",
            7000,
          );
        } finally {
          input.value = "";
        }
      }

      async function loadCookiesStatus() {
        const textEl = document.getElementById("cookies-status-text");
        const delBtn = document.getElementById("btn-cookies-delete");
        if (!textEl) return;
        try {
          const res = await fetch("/api/config/cookies");
          const data = await res.json();
          if (data.active) {
            const uploaded = data.uploaded_at
              ? new Date(data.uploaded_at).toLocaleString("de-DE", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "unbekannt";
            textEl.textContent = `✅ Aktiv (hochgeladen am ${uploaded})`;
            textEl.style.color = "var(--ok)";
            if (delBtn) delBtn.style.display = "";
          } else {
            textEl.textContent = "Keine Cookies hinterlegt.";
            textEl.style.color = "var(--ink-dim)";
            if (delBtn) delBtn.style.display = "none";
          }
        } catch (e) {
          textEl.textContent = "Status konnte nicht geladen werden.";
          textEl.style.color = "var(--ink-dim)";
        }
      }

      async function uploadCookiesFile() {
        const input = document.getElementById("cookies-upload-input");
        const file = input.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("file", file);

        try {
          const res = await fetch("/api/config/cookies", {
            method: "POST",
            body: formData,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
          showToast("Cookies erfolgreich hinterlegt.", "success");
          loadCookiesStatus();
        } catch (e) {
          showToast("Cookies-Upload fehlgeschlagen: " + e.message, "warn", 7000);
        } finally {
          input.value = "";
        }
      }

      async function deleteCookiesFile() {
        if (!confirm("Hinterlegte Cookies wirklich entfernen? Downloads laufen danach ohne Anmeldung."))
          return;
        try {
          const res = await fetch("/api/config/cookies", { method: "DELETE" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          showToast("Cookies entfernt.", "success");
          loadCookiesStatus();
        } catch (e) {
          showToast("Entfernen fehlgeschlagen: " + e.message, "warn");
        }
      }

      function openMediaInspector() {
        const select = document.getElementById("global-file-select");
        const input = select.value;
        if (!input) return showToast("Wähle zuerst eine Datei aus.", "warn");
        fetch(`/api/media-info?file_path=${encodeURIComponent(input)}`)
          .then((r) => r.json())
          .then((d) => {
            document.getElementById("media-info-json").textContent =
              JSON.stringify(d, null, 2);
            openModal("media-modal");
          });
      }

      function openModal(id) {
        document.getElementById(id).classList.add("active");
        if (id === "settings-modal") {
          loadYtDlpVersion();
          loadCookiesStatus();
        }
      }
