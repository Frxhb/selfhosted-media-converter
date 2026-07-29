function submitMuxJob() {
        const videoPath = document.getElementById("m-video-select").value;
        const audioPath = document.getElementById("m-audio-select").value;
        if (!videoPath || !audioPath)
          return showToast("Bitte Video- und Audiodatei wählen.", "warn");

        const videoName = videoPath
          .split("/")
          .pop()
          .replace(/\.[^/.]+$/, "");
        const outPath = `/media/outputs/videos/${videoName}_muxed.mkv`;
        const args = [
          "-hide_banner",
          "-y",
          "-i",
          videoPath,
          "-i",
          audioPath,
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          outPath,
        ];

        submitJob({
          job_type: "mux",
          tool: "ffmpeg",
          title: `Mux: ${videoName}`,
          command_args: args,
          input_file: videoPath,
          output_file: outPath,
        });
      }

      function submitWhisperJob() {
        const filePath = document.getElementById("sp-whisper-file").value;
        if (!filePath)
          return showToast("Bitte zuerst eine Datei wählen.", "warn");

        const model = document.getElementById("sp-whisper-model").value;
        const fmt = document.getElementById("sp-whisper-fmt").value;
        const fileName = filePath.split("/").pop();

        let lang = document.getElementById("sp-whisper-lang-select").value;
        if (lang === "custom") {
          lang = document.getElementById("sp-whisper-lang-input").value.trim();
        }

        const args = [
          "--model",
          model,
          "--output_format",
          fmt,
          "--output_dir",
          "/media/outputs/transcripts",
          "--verbose",
          "True",
        ];
        if (lang) {
          args.push("--language", lang);
        }
        args.push(filePath);

        submitJob({
          job_type: "whisper",
          tool: "whisper",
          title: fileName,
          command_args: args,
          input_file: filePath,
        });
      }

      function uploadBatchTxtFile() {
        const input = document.getElementById("d-batch-upload");
        if (!input.files || input.files.length === 0) return;

        const formData = new FormData();
        formData.append("file", input.files[0]);

        fetch("/api/files/upload", { method: "POST", body: formData })
          .then((r) => r.json())
          .then((res) => {
            refreshFiles();
            setTimeout(() => {
              document.getElementById("d-batch-select").value = res.path;
              updateDownloadPreview();
            }, 500);
          });
      }

      let activeDlEngine = "ytdlp";

      function preprocessGalleryUrl(rawUrl) {
        if (!rawUrl) return "";
        let url = rawUrl.trim();
        const wikiMediaMatch = url.match(
          /^(https?:\/\/[^\/]+)\/wiki\/.*#\/media\/(File|Datei):([^#\?\/]+)/i,
        );
        if (wikiMediaMatch) {
          const domain = wikiMediaMatch[1];
          const fileName = wikiMediaMatch[3];
          return `${domain}/wiki/File:${fileName}`;
        }
        return url;
      }

      function switchDlEngine(engine) {
        activeDlEngine = engine;
        document
          .querySelectorAll(".subtab-dl-engine")
          .forEach((btn) => btn.classList.remove("active"));
        const btn = document.getElementById(`btn-dl-engine-${engine}`);
        if (btn) btn.classList.add("active");

        const ytdlpOpts = document.getElementById("d-ytdlp-options");
        const gallerydlOpts = document.getElementById("d-gallerydl-options");
        const urlLabel = document.getElementById("d-url-label");
        const urlInput = document.getElementById("d-url");
        const fetchBtn = document.getElementById("d-fetch-btn");
        const searchSection = document.getElementById("d-ytdlp-search-section");
        const batchTextarea = document.getElementById("d-batch-textarea");

        if (engine === "gallerydl") {
          if (ytdlpOpts) ytdlpOpts.style.display = "none";
          if (gallerydlOpts) gallerydlOpts.style.display = "flex";
          if (urlLabel) urlLabel.textContent = "Galerie / Bild URL:";
          if (urlInput)
            urlInput.placeholder =
              "https://www.instagram.com/p/... oder https://... (Instagram, Pinterest, Reddit, Wiki...)";
          if (batchTextarea)
            batchTextarea.placeholder =
              "https://www.instagram.com/p/...\nhttps://www.pinterest.com/pin/...";
          if (fetchBtn) fetchBtn.style.display = "none";
          if (searchSection) searchSection.style.display = "none";
          updateGalleryDlPreview();
        } else {
          if (gallerydlOpts) gallerydlOpts.style.display = "none";
          if (ytdlpOpts) ytdlpOpts.style.display = "flex";
          if (urlLabel) urlLabel.textContent = "Video / Playlist URL:";
          if (urlInput)
            urlInput.placeholder = "https://www.youtube.com/watch?v=...";
          if (batchTextarea)
            batchTextarea.placeholder =
              "https://youtube.com/watch?v=1\nhttps://youtube.com/watch?v=2";
          if (fetchBtn) fetchBtn.style.display = "inline-block";
          if (searchSection) searchSection.style.display = "block";
          if (typeof updateYtdlpPreview === "function") updateYtdlpPreview();
        }
      }

      function updateDownloadPreview() {
        if (activeDlEngine === "gallerydl") {
          updateGalleryDlPreview();
        } else if (typeof updateYtdlpPreview === "function") {
          updateYtdlpPreview();
        }
      }

      function toggleGalleryRangeInput() {
        const mode = document.getElementById("g-range-mode")?.value;
        const valInput = document.getElementById("g-range-val");
        if (valInput) {
          valInput.style.display = mode === "custom" ? "block" : "none";
        }
      }

      function updateGalleryDlPreview() {
        const dest =
          document.getElementById("g-dest")?.value || "/media/outputs/images";
        const customFlags =
          document.getElementById("g-custom-flags")?.value.trim() || "";
        const rangeMode =
          document.getElementById("g-range-mode")?.value || "all";
        const rangeVal =
          document.getElementById("g-range-val")?.value.trim() || "";

        let target = "URL_HIER";
        if (activeDlSubTab === "single") {
          const raw = document.getElementById("d-url")?.value;
          target = preprocessGalleryUrl(sanitizeUrl(raw)) || "URL_HIER";
        } else {
          const batchSel = document.getElementById("d-batch-select")?.value;
          target = batchSel ? `-i "${batchSel}"` : "-i [BATCH_URLS]";
        }
        let args = ["gallery-dl", "--no-mtime", "--dest", `"${dest}"`];
        if (rangeMode === "first") {
          args.push("--range 1");
        } else if (rangeMode === "custom" && rangeVal) {
          args.push(`--range "${rangeVal}"`);
        }
        if (customFlags) args.push(customFlags);
        args.push(target);
        const preview = document.getElementById("g-cmd-preview");
        if (preview) preview.textContent = args.join(" ");
      }

      async function handleDownloadSubmit() {
        clearDuplicateWarning();
        if (activeDlEngine === "gallerydl") {
          return handleGalleryDlSubmit();
        }

        const type = document.getElementById("d-type").value;
        const res = document.getElementById("d-res").value;
        const container = document.getElementById("d-container").value;
        const customFlags = document
          .getElementById("d-custom-flags")
          .value.trim();

        let baseArgs = ["--no-colors", "--remote-components", "ejs:github"];

        // Browser-Sprache ermitteln (z.B. "de")
        const userLang = (window.navigator?.language || "de").split("-")[0];
        
        // Sprache über Extractor-Argumente UND HTTP-Header erzwingen
        baseArgs.push("--extractor-args", `youtube:lang=${userLang}`);
        baseArgs.push("--add-header", `Accept-Language:${userLang},${userLang}-${userLang.toUpperCase()};q=0.9,en;q=0.8`);
        
        // Automatischer 403 Forbidden Fallback (default -> android -> ios -> web)
        baseArgs.push("--extractor-args", "youtube:player_client=default,android,ios,web");

        if (type === "audio") {
          baseArgs.push(
            "-x",
            "--audio-format",
            container,
            "--audio-quality",
            res,
          );
        } else {
          if (res !== "best")
            baseArgs.push("-f", `bestvideo[height<=${res}]+bestaudio/best`);
          baseArgs.push("--merge-output-format", container);
        }

        if (customFlags) {
          customFlags.split(" ").forEach((f) => {
            if (f) baseArgs.push(f);
          });
        }

        if (activeDlSubTab === "single") {
          const url = sanitizeUrl(document.getElementById("d-url").value);
          if (!url) return showToast("Bitte URL eingeben.", "warn");

          if (url.includes("list=") || url.includes("playlist?")) {
            pendingDownloadContext = { baseArgs, targetUrl: url };
            showPlaylistActionsView();
            openModal("playlist-modal");
            return;
          }

          // Titel automatisch im Hintergrund auflösen, falls noch kein Info-Fetch gemacht wurde
          const rawPreview =
            document.getElementById("d-info-title")?.textContent || "";
          if (rawPreview.trim() === "-" || !rawPreview.trim()) {
            showToast("Hole Video-Informationen...", "info", 2000);
            try {
              // WICHTIG: Auch hier die Sprache an den Backend-Endpunkt übergeben!
              const infoRes = await fetch(
                `/api/ytdlp-info?url=${encodeURIComponent(url)}&lang=${userLang}`,
              );
              if (infoRes.ok) {
                const info = await infoRes.json();
                if (info.title && info.title !== "Unbekannt") {
                  document.getElementById("d-info-title").textContent =
                    info.title;
                  document.getElementById("d-info-uploader").textContent =
                    info.uploader || "-";
                  document.getElementById("d-info-duration").textContent =
                    info.duration || "-";
                  if (info.thumbnail)
                    document.getElementById("d-info-thumb").src =
                      info.thumbnail;
                  document.getElementById("d-info-preview").style.display =
                    "flex";
                }
              }
            } catch (e) {}
          }

          executeDownloadJob(baseArgs, url, ["--no-playlist"]);
        } else {
          const isAudio = baseArgs.includes("-x");
          const batchOutputSubdir = isAudio ? "audio" : "videos";

          const batchFile = document.getElementById("d-batch-select").value;
          const textarea = document
            .getElementById("d-batch-textarea")
            .value.trim();

          if (batchFile) {
            let args = [
              "-a",
              batchFile,
              ...baseArgs,
              "--no-playlist",
              "--paths",
              `temp:/tmp/ytdlp_staging`,
              "-o",
              `/media/outputs/${batchOutputSubdir}/%(title)s.%(ext)s`,
            ];
            await submitJob({
              job_type: "download",
              tool: "yt-dlp",
              title: `Batch (${batchFile.split("/").pop()})`,
              command_args: args,
              input_file: batchFile,
            });
          } else if (textarea) {
            const links = textarea
              .split("\n")
              .map((l) => sanitizeUrl(l))
              .filter((l) => l.length > 0);

            if (links.length > 1) {
              showToast(
                `${links.length} Links werden nacheinander gestartet...`,
                "info",
                3000,
              );
            }

            for (let idx = 0; idx < links.length; idx++) {
              const link = links[idx];
              let args = [
                ...baseArgs,
                "--no-playlist",
                "--paths",
                `temp:/tmp/ytdlp_staging`,
                "-o",
                `/media/outputs/${batchOutputSubdir}/%(title)s.%(ext)s`,
                link,
              ];
              const shortUrl =
                link.length > 40 ? link.slice(0, 40) + "…" : link;
              await submitJob({
                job_type: "download",
                tool: "yt-dlp",
                title: `Batch-Link ${idx + 1}/${links.length}: ${shortUrl}`,
                command_args: args,
                input_file: link,
              });
              if ((idx + 1) % 3 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
            }
          } else {
            showToast(
              "Bitte eine .txt Datei hochladen/wählen oder Links einfügen.",
              "warn",
            );
          }
        }
      }

      async function handleGalleryDlSubmit() {
        const dest =
          document.getElementById("g-dest")?.value || "/media/outputs/images";
        const customFlags =
          document.getElementById("g-custom-flags")?.value.trim() || "";
        const rangeMode =
          document.getElementById("g-range-mode")?.value || "all";
        const rangeVal =
          document.getElementById("g-range-val")?.value.trim() || "";

        let baseArgs = ["--no-mtime", "--dest", dest];
        if (rangeMode === "first") {
          baseArgs.push("--range", "1");
        } else if (rangeMode === "custom" && rangeVal) {
          baseArgs.push("--range", rangeVal);
        }
        if (customFlags) {
          customFlags.split(" ").forEach((f) => {
            if (f) baseArgs.push(f);
          });
        }

        if (activeDlSubTab === "single") {
          const rawUrl = document.getElementById("d-url").value;
          const url = preprocessGalleryUrl(sanitizeUrl(rawUrl));
          if (!url) return showToast("Bitte URL eingeben.", "warn");
          const shortUrl = url.length > 35 ? url.slice(0, 35) + "…" : url;

          clearDuplicateWarning();
          await submitJob({
            job_type: "download",
            tool: "gallery-dl",
            title: `Gallery: ${shortUrl}`,
            command_args: [...baseArgs, url],
            input_file: url,
          });
        } else {
          const batchFile = document.getElementById("d-batch-select").value;
          const textarea = document.getElementById("d-batch-textarea").value.trim();

          if (batchFile) {
            let args = ["-i", batchFile, ...baseArgs];
            clearDuplicateWarning();
            await submitJob({
              job_type: "download",
              tool: "gallery-dl",
              title: `Gallery Batch (${batchFile.split("/").pop()})`,
              command_args: args,
              input_file: batchFile,
            });
          } else if (textarea) {
            const links = textarea
              .split("\n")
              .map((l) => preprocessGalleryUrl(sanitizeUrl(l)))
              .filter((l) => l.length > 0);

            if (links.length > 1) {
              showToast(
                `${links.length} Gallery-Links werden nacheinander gestartet...`,
                "info",
                3000,
              );
            }

            clearDuplicateWarning();
            for (let idx = 0; idx < links.length; idx++) {
              const link = links[idx];
              const shortUrl = link.length > 35 ? link.slice(0, 35) + "…" : link;
              await submitJob({
                job_type: "download",
                tool: "gallery-dl",
                title: `Gallery Batch ${idx + 1}/${links.length}: ${shortUrl}`,
                command_args: [...baseArgs, link],
                input_file: link,
              });
              if ((idx + 1) % 3 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 300));
              }
            }
          } else {
            showToast(
              "Bitte eine .txt Datei hochladen/wählen oder Links einfügen.",
              "warn",
            );
          }
        }
      }

      function executeDownloadJob(
        baseArgs,
        targetUrl,
        extraFlags = [],
        customTitle = null,
      ) {
        clearDuplicateWarning();
        const isAudio = baseArgs.includes("-x");
        const outputSubdir = isAudio ? "audio" : "videos";

        let finalArgs = [
          ...baseArgs,
          ...extraFlags,
          "--paths",
          `temp:/tmp/ytdlp_staging`,
          "-o",
          `/media/outputs/${outputSubdir}/%(title)s.%(ext)s`,
          targetUrl,
        ];

        const rawPreview =
          document.getElementById("d-info-title")?.textContent || "";
        const previewTitle = rawPreview.trim();
        let jobTitle = customTitle;
        if (!jobTitle && previewTitle && previewTitle !== "-") {
          jobTitle = previewTitle;
        }

        submitJob({
          job_type: "download",
          tool: "yt-dlp",
          title: jobTitle || "Web Download",
          command_args: finalArgs,
          input_file: targetUrl,
          is_playlist: targetUrl.includes("list="),
        });
      }

      function showPlaylistActionsView() {
        document.getElementById("playlist-actions-view").style.display = "flex";
        document.getElementById("playlist-full-confirm-view").style.display =
          "none";
        document.getElementById("playlist-picker-view").style.display = "none";
      }

      function confirmFullPlaylistDownload() {
        if (!pendingDownloadContext) return;
        if (!configuredConfirmPlaylist) {
          handlePlaylistChoice("full");
          return;
        }
        document.getElementById("playlist-actions-view").style.display = "none";
        document.getElementById("playlist-full-confirm-view").style.display =
          "flex";
      }

      function handlePlaylistChoice(choice) {
        if (!pendingDownloadContext) return;
        const { baseArgs, targetUrl } = pendingDownloadContext;

        if (choice === "single") {
          executeDownloadJob(baseArgs, targetUrl, ["--no-playlist"]);
        } else if (choice === "full") {
          executeDownloadJob(baseArgs, targetUrl, ["--yes-playlist"]);
        }

        closeModal("playlist-modal");
        pendingDownloadContext = null;
      }

      async function searchYtDlpByTitle() {
        const query = document.getElementById("d-search-query").value.trim();
        const resultsContainer = document.getElementById("d-search-results");
        if (!query) return showToast("Bitte einen Suchbegriff eingeben.", "warn");

        const btn = document.getElementById("d-search-btn");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Suche...";
        resultsContainer.style.display = "flex";
        resultsContainer.innerHTML =
          '<p style="text-align:center; color:var(--ink-dim); font-size:0.75rem; margin:0.5rem 0;">Suche läuft...</p>';
        clearDuplicateWarning();

        try {
          const searchPseudoUrl = `ytsearch8:${query}`;
          const userLang = (window.navigator?.language || "de").split("-")[0];
          
          const res = await fetch(
            `/api/ytdlp-playlist-items?url=${encodeURIComponent(searchPseudoUrl)}&lang=${userLang}`,
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Suche fehlgeschlagen.");
          }
          const items = await res.json();

          if (items.length === 0) {
            resultsContainer.innerHTML =
              '<p style="text-align:center; color:var(--ink-dim); font-size:0.75rem; margin:0.5rem 0;">Keine Ergebnisse gefunden.</p>';
            return;
          }

          resultsContainer.innerHTML = "";
          items.forEach((item) => {
            if (!item.id) return; 
            const div = document.createElement("div");
            div.className = "queue-item";
            div.style.cursor = "pointer";
            div.style.gap = "0.5rem";
            div.innerHTML = `
                        <span style="font-weight:700; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
                        <span style="color:var(--ink-dim); font-size:0.68rem;">${escapeHtml(item.duration || "")}</span>
                    `;
            div.onclick = () => selectSearchResult(item.id, item.title);
            resultsContainer.appendChild(div);
          });
        } catch (e) {
          resultsContainer.innerHTML = `<p style="text-align:center; color:var(--danger); font-size:0.75rem; margin:0.5rem 0;">${e.message}</p>`;
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      function selectSearchResult(videoId, title) {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        document.getElementById("d-url").value = url;
        document.getElementById("d-search-results").style.display = "none";
        document.getElementById("d-search-query").value = "";
        showToast(`Ausgewählt: ${title}`, "success");
        
        // WICHTIG: Vorschau & GUI updaten, da JavaScript-Wertänderungen kein "oninput" auslösen
        if (typeof updateYtdlpPreview === "function") updateYtdlpPreview();
        if (typeof clearDuplicateWarning === "function") clearDuplicateWarning();
        
        // Info abrufen starten (sobald verfügbar)
        if (typeof fetchYtDlpInfo === "function") fetchYtDlpInfo();
      }

      async function openPlaylistPickerView() {
        if (!pendingDownloadContext) return;
        document.getElementById("playlist-actions-view").style.display = "none";
        document.getElementById("playlist-picker-view").style.display = "flex";

        const container = document.getElementById("playlist-items-list");
        container.innerHTML =
          '<p style="text-align: center; color: var(--ink-dim); font-size: 0.75rem; margin-top: 3.5rem;">Lade Playlist-Titel vom Server...</p>';

        try {
          const userLang = (window.navigator?.language || "de").split("-")[0];
          const res = await fetch(
            `/api/ytdlp-playlist-items?url=${encodeURIComponent(pendingDownloadContext.targetUrl)}&lang=${userLang}`,
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
              err.detail || "Fehler beim Abrufen der Playlist-Einträge",
            );
          }
          const items = await res.json();

          if (items.length === 0) {
            container.innerHTML =
              '<p style="text-align:center; color:var(--danger); font-size:0.75rem; margin-top:3rem;">Keine Titel gefunden.</p>';
            return;
          }

          container.innerHTML = "";
          items.forEach((item) => {
            container.innerHTML += `
                        <div class="queue-item" style="gap:0.5rem;">
                            <input type="checkbox" class="pl-item-check" data-index="${item.index}" checked>
                            <span style="font-weight:700; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.title)}">${item.index}. ${escapeHtml(item.title)}</span>
                            <span style="color:var(--ink-dim); font-size:0.68rem;">${escapeHtml(item.duration)}</span>
                        </div>
                    `;
          });
        } catch (e) {
          container.innerHTML = `<p style="text-align:center; color:var(--danger); font-size:0.75rem; margin-top:3rem;">${e.message}</p>`;
        }
      }

      function selectAllPlaylistCheckboxes(checked) {
        document
          .querySelectorAll(".pl-item-check")
          .forEach((cb) => (cb.checked = checked));
      }

      function confirmSelectedPlaylistItems() {
        if (!pendingDownloadContext) return;
        const checked = document.querySelectorAll(".pl-item-check:checked");
        if (checked.length === 0)
          return showToast("Bitte wähle mindestens ein Video aus.", "warn");

        const selectedIndices = Array.from(checked)
          .map((cb) => cb.getAttribute("data-index"))
          .join(",");
        const extraFlags = ["--playlist-items", selectedIndices];

        executeDownloadJob(
          pendingDownloadContext.baseArgs,
          pendingDownloadContext.targetUrl,
          extraFlags,
          `Playlist (${checked.length} Titel)`,
        );

        closeModal("playlist-modal");
        pendingDownloadContext = null;
      }

      function renderJobDetailsFiles(extractedTitles, minVisible) {
        const filesContainer = document.getElementById("job-details-files");
        const expandBtn = document.getElementById(
          "job-details-files-expand-btn",
        );
        const expanded = window.jobDetailsFilesExpanded;
        const showCount = expanded
          ? extractedTitles.length
          : Math.min(minVisible, extractedTitles.length);

        filesContainer.innerHTML = "";
        for (let idx = 0; idx < showCount; idx++) {
          filesContainer.innerHTML += `
                        <div class="queue-item">
                            <span style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🎵 ${idx + 1}. ${extractedTitles[idx]}</span>
                        </div>
                    `;
        }

        if (extractedTitles.length > minVisible) {
          expandBtn.style.display = "inline-flex";
          expandBtn.textContent = expanded
            ? "Weniger anzeigen"
            : `Alle ${extractedTitles.length} anzeigen`;
        } else {
          expandBtn.style.display = "none";
        }
      }

      function toggleJobDetailsFilesExpand() {
        window.jobDetailsFilesExpanded = !window.jobDetailsFilesExpanded;
        renderJobDetailsFiles(window.jobDetailsExtractedTitles || [], 10);
      }

      async function openJobDetails(jobId) {
        let job = clientJobs[jobId];
        if (!job) {
          try {
            const res = await fetch("/api/jobs");
            if (res.ok) {
              serverJobsCache = await res.json();
            }
          } catch (e) {}
          job = serverJobsCache.find((j) => j.id === jobId);
        }
        if (!job) return;

        document.getElementById("job-details-header").textContent =
          `Job: ${job.title}`;

        let plInfo = "";
        if (job.is_playlist && job.playlist_index && job.playlist_count) {
          plInfo = ` | <strong>Playlist:</strong> Video ${job.playlist_index} von ${job.playlist_count}`;
        }

        const processingMode =
          job.id && job.id.startsWith("local_") ? "Client (WASM)" : "Server";

        document.getElementById("job-details-meta").innerHTML = `
                <strong>ID:</strong> ${job.id} | <strong>Modus:</strong> ${processingMode} | <strong>Tool:</strong> ${job.tool} | <strong>Status:</strong> ${job.status.toUpperCase()} | <strong>Fortschritt:</strong> ${job.progress}%${plInfo}
            `;

        const filesContainer = document.getElementById("job-details-files");
        const fileMap = new Map();

        if (job.logs && job.logs.length > 0) {
          job.logs.forEach((line) => {
            const match =
              line.match(
                /\[(?:download|ExtractAudio|Merger)\] Destination:\s*\/media\/outputs\/(.+)/,
              ) ||
              line.match(
                /\[download\]\s*\/media\/outputs\/(.+?)\s+has already been downloaded/,
              );
            if (match) {
              const fullFilename = match[1].split(".f")[0];
              const lastDot = fullFilename.lastIndexOf(".");
              const baseName =
                lastDot !== -1
                  ? fullFilename.substring(0, lastDot)
                  : fullFilename;
              fileMap.set(baseName, fullFilename);
            }
          });
        }
        const extractedTitles = Array.from(fileMap.values());
        const MIN_VISIBLE_TITLES = 10;
        window.jobDetailsExtractedTitles = extractedTitles;
        window.jobDetailsFilesExpanded = false;

        const expandBtn = document.getElementById(
          "job-details-files-expand-btn",
        );
        const headerEl = document.getElementById("job-details-files-header");

        if (extractedTitles.length > 0) {
          if (headerEl)
            headerEl.textContent = "Extrahierte / heruntergeladene Titel:";
          renderJobDetailsFiles(extractedTitles, MIN_VISIBLE_TITLES);
        } else if (job.current_item_title) {
          if (headerEl) headerEl.textContent = "Aktuell ladender Titel:";
          expandBtn.style.display = "none";
          filesContainer.innerHTML = `<div class="queue-item"><span style="font-weight:700;">🎵 ${escapeHtml(job.current_item_title)}</span></div>`;
        } else {
          if (headerEl) headerEl.textContent = "Verarbeitete Datei:";
          expandBtn.style.display = "none";
          filesContainer.innerHTML = `<div class="queue-item"><span style="font-weight:700;">📄 ${escapeHtml(job.title)}</span></div>`;
        }

        document.getElementById("job-details-logs").textContent =
          job.logs && job.logs.length > 0
            ? job.logs.join("\n")
            : "Keine Log-Einträge vorhanden.";
        openModal("job-details-modal");
      }
