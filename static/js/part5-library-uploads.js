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
        if (!path) return showToast(t("toast.select_a_file"), "warn");

        // Bestimme den erwarteten Typ für den aktuellen Tab
        let expectedType = "video"; // Default
        if (activeConvSubTab === "audio") expectedType = "audio";
        if (activeConvSubTab === "images") expectedType = "image";
        if (activeConvSubTab === "tools") expectedType = "tools";

        showToast(t("toast.checking_file_integrity"), "info", 1500);

        // Strikte Validierung
        const isValid = await validateFileStrict(path, expectedType);

        if (!isValid) {
          // Hier geben wir dem User die Info, dass es am Format liegt
          showToast(
            t("toast.file_rejected").replace("{type}", expectedType.toUpperCase()),
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
        showToast(t("toast.file_added"), "success");
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
        statusText.textContent = t("label.upload_starting").replace("{size}", fileSizeMb);

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
            statusText.textContent = t("label.upload_progress").replace("{pct}", pct).replace("{loaded}", loadedMb).replace("{total}", fileSizeMb);
          }
        };

        xhr.onabort = () => {
          currentUploadXhr = null;
          if (cancelBtn) cancelBtn.style.display = "none";
          fill.classList.add("warn-fill");
          statusText.style.color = "var(--warn)";
          statusText.textContent = t("label.upload_cancelled_icon");
          showToast(t("toast.upload_cancelled"), "info");

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
            statusText.textContent = t("label.upload_success_icon");
            showToast(t("toast.file_uploaded").replace("{name}", file.name), "success");

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
            showToast(t("toast.upload_failed").replace("{detail}", errDetail), "warn", 7000);

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
          statusText.textContent = t("label.network_error_icon");
          showToast(t("toast.network_error_upload"), "warn");
        };

        xhr.send(formData);
      }

      async function resetGuiAndRefresh() {
        try {
          await clearCompletedServerJobs();
        } catch (e) {}

        const consoleEl = document.getElementById("log-console");
        if (consoleEl) consoleEl.textContent = "";

        ["audio", "video", "images", "tools"].forEach((tab) => {
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

        showToast(t("toast.ui_queue_reset"), "success", 2000);
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
          select.innerHTML = `<option value="">${t("downloader.select_file_default")}</option>`;
          muxVid.innerHTML = `<option value="">${t("downloader.select_video_default")}</option>`;
          muxAud.innerHTML = `<option value="">${t("downloader.select_audio_default")}</option>`;
          batchDl.innerHTML =
            `<option value="">${t("downloader.select_txt_default")}</option>`;
          whisperSelect.innerHTML =
            `<option value="">${t("downloader.select_file_default")}</option>`;

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
          console.error("Error loading files:", e);
          showToast(t("toast.error_loading_file_list"), "warn");
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
              t("confirm.similar_files_found").replace("{names}", names),
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
              if (confirm(t("confirm.job_failed_retry").replace("{detail}", detail))) {
                return submitJob(payload, true);
              }
              return;
            }
            showToast(t("toast.job_not_started").replace("{detail}", detail), "warn", 7000);
            appendLog(
              `[${t("label.tag_error")}] ${t("label.log_job_not_started").replace("{title}", payload.title || payload.job_type).replace("{detail}", detail)}`,
            );
            return;
          }

          const job = await res.json();
          appendLog(`[SYSTEM] ${t("label.system_job_started").replace("{id}", job.id)}`);
          showToast(t("toast.job_started").replace("{title}", job.title), "success");
          loadJobs();
        } catch (e) {
          showToast(t("toast.error_prefix") + e.message, "warn");
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
              badge.textContent = t("label.saved_settings_active");
              badge.title = t("label.saved_settings_active_hint");
            } else {
              badge.textContent = t("label.env_defaults_not_saved");
              badge.title = t("label.env_defaults_hint");
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
        btn.textContent = t("label.saving");

        try {
          const res = await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
              err.detail || t("toast.save_error_http").replace("{status}", res.status),
            );
          }

          configuredMinDiskGb = payload.min_free_disk_gb;
          configuredConfirmPlaylist = payload.confirm_full_playlist_downloads;

          showToast(t("toast.settings_saved"), "success");
          closeModal("settings-modal");
        } catch (e) {
          showToast(
            t("toast.settings_save_failed") + e.message,
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
        el.textContent = t("label.loading_ellipsis");
        try {
          const res = await fetch("/api/system/ytdlp-version");
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          el.textContent = data.version || t("label.unknown");
        } catch (e) {
          el.textContent = t("toast.error_prefix") + e.message;
        }
      }

      async function checkAndUpdateYtDlp() {
        const btn = document.getElementById("btn-ytdlp-update");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t("label.checking_updating");
        try {
          const res = await fetch("/api/system/ytdlp-update", {
            method: "POST",
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
          document.getElementById("ytdlp-version-display").textContent =
            data.version || t("label.unknown");
          showToast(
            t("toast.ytdlp_updated").replace("{version}", data.version || "").trim(),
            "success",
          );
        } catch (e) {
          showToast(t("toast.ytdlp_update_failed") + e.message, "warn", 7000);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      async function restoreConfigBackup() {
        const input = document.getElementById("config-restore-input");
        const file = input.files[0];
        if (!file) return;
        if (!confirm(t("confirm.restore_overwrite"))) {
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
            data.detail || t("toast.backup_restored"),
            "success",
            7000,
          );
          loadServerConfig();
          fetchStats();
        } catch (e) {
          showToast(
            t("toast.restore_failed") + e.message,
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
              : t("label.unknown");
            textEl.textContent = t("label.cookies_active").replace("{date}", uploaded);
            textEl.style.color = "var(--ok)";
            if (delBtn) delBtn.style.display = "";
          } else {
            textEl.textContent = t("toast.no_cookies_stored");
            textEl.style.color = "var(--ink-dim)";
            if (delBtn) delBtn.style.display = "none";
          }
        } catch (e) {
          textEl.textContent = t("toast.cookies_status_load_failed");
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
          showToast(t("toast.cookies_uploaded"), "success");
          loadCookiesStatus();
        } catch (e) {
          showToast(t("toast.cookies_upload_failed") + e.message, "warn", 7000);
        } finally {
          input.value = "";
        }
      }

      async function deleteCookiesFile() {
        if (!confirm(t("confirm.remove_cookies")))
          return;
        try {
          const res = await fetch("/api/config/cookies", { method: "DELETE" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          showToast(t("toast.cookies_removed"), "success");
          loadCookiesStatus();
        } catch (e) {
          showToast(t("toast.remove_failed") + e.message, "warn");
        }
      }

      function openMediaInspector() {
        const select = document.getElementById("global-file-select");
        const input = select.value;
        if (!input) return showToast(t("toast.choose_file_first"), "warn");
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
