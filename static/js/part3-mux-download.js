function tokenizeCliFlags(str) {
        const tokens = [];
        const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
        let m;
        while ((m = re.exec(str)) !== null) {
          tokens.push(m[1] ?? m[2] ?? m[3]);
        }
        return tokens;
      }

      function submitMuxJob() {
        const videoPath = document.getElementById("m-video-select").value;
        const audioPath = document.getElementById("m-audio-select").value;
        if (!videoPath || !audioPath)
          return showToast(t("toast.select_video_audio_file"), "warn");

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
          return showToast(t("toast.select_file_first"), "warn");

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
          if (urlLabel) urlLabel.textContent = t("downloader.gallery_url_label");
          if (urlInput)
            urlInput.placeholder = t("downloader.gallery_url_ph");
          if (batchTextarea)
            batchTextarea.placeholder = t("downloader.batch_gallery_ph");
          if (fetchBtn) fetchBtn.style.display = "none";
          if (searchSection) searchSection.style.display = "none";
          updateGalleryDlPreview();
        } else {
          if (gallerydlOpts) gallerydlOpts.style.display = "none";
          if (ytdlpOpts) ytdlpOpts.style.display = "flex";
          if (urlLabel) urlLabel.textContent = t("downloader.url_label");
          if (urlInput)
            urlInput.placeholder = t("downloader.url_placeholder");
          if (batchTextarea)
            batchTextarea.placeholder = t("downloader.batch_ph");
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
          tokenizeCliFlags(customFlags).forEach((f) => {
            if (f) baseArgs.push(f);
          });
        }

        if (activeDlSubTab === "single") {
          const url = sanitizeUrl(document.getElementById("d-url").value);
          if (!url) return showToast(t("toast.enter_url"), "warn");

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
            showToast(t("toast.fetching_video_info"), "info", 2000);
            try {
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

          const isLiveStream =
            document.getElementById("d-is-livestream")?.checked || false;
          executeDownloadJob(baseArgs, url, ["--no-playlist"], null, isLiveStream);
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
              `home:/media/outputs/${batchOutputSubdir}`,
              "--paths",
              `temp:/tmp/ytdlp_staging`,
              "-o",
              `%(title)s.%(ext)s`,
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
                t("toast.starting_links").replace("{count}", links.length),
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
                `home:/media/outputs/${batchOutputSubdir}`,
                "--paths",
                `temp:/tmp/ytdlp_staging`,
                "-o",
                `%(title)s.%(ext)s`,
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
            showToast(t("toast.upload_or_select_txt_or_paste"), "warn");
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
          tokenizeCliFlags(customFlags).forEach((f) => {
            if (f) baseArgs.push(f);
          });
        }

        if (activeDlSubTab === "single") {
          const rawUrl = document.getElementById("d-url").value;
          const url = preprocessGalleryUrl(sanitizeUrl(rawUrl));
          if (!url) return showToast(t("toast.enter_url"), "warn");
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
                t("toast.starting_gallery_links").replace("{count}", links.length),
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
            showToast(t("toast.upload_or_select_txt_or_paste"), "warn");
          }
        }
      }

      function stripFlagWithValue(args, flagNames) {
        const result = [];
        for (let i = 0; i < args.length; i++) {
          if (flagNames.includes(args[i])) {
            i++; // skip this flag's value too
            continue;
          }
          result.push(args[i]);
        }
        return result;
      }

      function executeDownloadJob(
        baseArgs,
        targetUrl,
        extraFlags = [],
        customTitle = null,
        isLiveStream = false,
      ) {
        clearDuplicateWarning();
        const isAudio = baseArgs.includes("-x");
        const outputSubdir = isAudio ? "audio" : "videos";
        const filePrefix = isLiveStream ? "live_record_" : "";

        let effectiveBaseArgs = baseArgs;
        const liveFlags = isLiveStream
          ? ["--hls-use-mpegts", "--no-part"]
          : [];

        if (isLiveStream && !isAudio) {
          effectiveBaseArgs = stripFlagWithValue(baseArgs, [
            "-f",
            "--merge-output-format",
          ]);
          effectiveBaseArgs.push("-f", "b");
        }

        let finalArgs = [
          ...effectiveBaseArgs,
          ...extraFlags,
          ...liveFlags,
          "--paths",
          `home:/media/outputs/${outputSubdir}`,
          "--paths",
          `temp:/tmp/ytdlp_staging`,
          "-o",
          `${filePrefix}%(title)s.%(ext)s`,
          targetUrl,
        ];

        const rawPreview =
          document.getElementById("d-info-title")?.textContent || "";
        const previewTitle = rawPreview.trim();
        let jobTitle = customTitle;
        if (!jobTitle && previewTitle && previewTitle !== "-") {
          jobTitle = previewTitle;
        }
        jobTitle = jobTitle || "Web Download";
        if (isLiveStream) jobTitle = `${filePrefix}${jobTitle}`;

        submitJob({
          job_type: "download",
          tool: "yt-dlp",
          title: jobTitle,
          command_args: finalArgs,
          input_file: targetUrl,
          is_playlist: targetUrl.includes("list="),
          is_live_stream: isLiveStream,
        });
      }

      function showPlaylistActionsView() {
        document.getElementById("playlist-actions-view").style.display = "flex";
        document.getElementById("playlist-full-confirm-view").style.display =
          "none";
        document.getElementById("playlist-picker-view").style.display = "none";

        // Warnung anzeigen, falls es sich um einen dynamischen YouTube-Mix handelt (list=RD...)
        const msgEl = document.querySelector("#playlist-actions-view p");
        if (msgEl && pendingDownloadContext) {
          if (pendingDownloadContext.targetUrl.includes("list=RD")) {
            msgEl.innerHTML = `${t('modals.playlist_detected_msg', 'Ein Playlist-Link wurde erkannt.')}<br><strong style="color:var(--accent);">⚠️ YouTube Radio Mix (RDMM): Titel werden von YouTube dynamisch generiert.</strong>`;
          } else {
            msgEl.textContent = t('modals.playlist_detected_msg', 'Ein Playlist-Link wurde erkannt. Wie möchtest du mit dem Download fortfahren?');
          }
        }
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
          // Falls es ein YouTube Radio Mix (list=RD...) ist, den list-Parameter entfernen,
          // damit yt-dlp exakt das eine gewählte Einzelvideo lädt.
          let cleanUrl = targetUrl;
          if (targetUrl.includes("list=RD")) {
            cleanUrl = targetUrl.replace(/([&?])list=RD[^&]*/, '').replace(/[?&]$/, '');
          }
          executeDownloadJob(baseArgs, cleanUrl, ["--no-playlist"]);
        } else if (choice === "full") {
          executeDownloadJob(baseArgs, targetUrl, ["--yes-playlist"]);
        }

        closeModal("playlist-modal");
        pendingDownloadContext = null;
      }

      let ytdlpSearchInFlight = false;
      let ytdlpSearchResults = [];
      let ytdlpSearchActiveIndex = -1;

      async function searchYtDlpByTitle() {
        const query = document.getElementById("d-search-query").value.trim();
        const resultsContainer = document.getElementById("d-search-results");
        if (!query) return showToast(t("downloader.toast_enter_query"), "warn");
        if (ytdlpSearchInFlight) return;

        ytdlpSearchInFlight = true;
        ytdlpSearchResults = [];
        ytdlpSearchActiveIndex = -1;

        const btn = document.getElementById("d-search-btn");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t("downloader.searching");
        resultsContainer.style.display = "flex";
        resultsContainer.innerHTML =
          `<p style="text-align:center; color:var(--ink-dim); font-size:0.75rem; margin:0.5rem 0;">${t("downloader.search_running")}</p>`;
        clearDuplicateWarning();

        try {
          const userLang = (window.navigator?.language || "de").split("-")[0];

          const res = await fetch(
            `/api/ytdlp-search?q=${encodeURIComponent(query)}&max_results=8&lang=${userLang}`,
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || t("toast.search_failed"));
          }
          const items = await res.json();

          if (items.length === 0) {
            resultsContainer.innerHTML =
              `<p style="text-align:center; color:var(--ink-dim); font-size:0.75rem; margin:0.5rem 0;">${t("downloader.no_results")}</p>`;
            return;
          }

          ytdlpSearchResults = items.filter((item) => !!item.id);
          renderSearchResults();
        } catch (e) {
          resultsContainer.innerHTML = `<p style="text-align:center; color:var(--danger); font-size:0.75rem; margin:0.5rem 0;">${e.message}</p>`;
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
          ytdlpSearchInFlight = false;
        }
      }

      function renderSearchResults() {
        const resultsContainer = document.getElementById("d-search-results");
        resultsContainer.innerHTML = "";
        ytdlpSearchResults.forEach((item, idx) => {
          const div = document.createElement("div");
          div.className = "queue-item";
          div.dataset.searchIdx = String(idx);
          div.style.cursor = "pointer";
          div.style.gap = "0.5rem";
          if (idx === ytdlpSearchActiveIndex) {
            div.style.outline = "2px solid var(--accent, #5b8def)";
            div.style.outlineOffset = "-2px";
          }
          const subtitle = item.uploader
            ? `<span style="color:var(--ink-dim); font-size:0.66rem;">${escapeHtml(item.uploader)}</span>`
            : "";
          div.innerHTML = `
                        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:0.1rem;">
                          <span style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
                          ${subtitle}
                        </div>
                        <span style="color:var(--ink-dim); font-size:0.68rem; flex-shrink:0;">${escapeHtml(item.duration || "")}</span>
                    `;
          div.onclick = () => selectSearchResult(item.id, item.title);
          div.onmouseenter = () => {
            ytdlpSearchActiveIndex = idx;
            renderSearchResults();
          };
          resultsContainer.appendChild(div);
        });
      }

      function handleSearchInputKeydown(event) {
        const hasResults = ytdlpSearchResults.length > 0;
        const resultsVisible =
          document.getElementById("d-search-results").style.display !== "none";

        if (event.key === "Enter") {
          event.preventDefault();
          if (hasResults && resultsVisible && ytdlpSearchActiveIndex >= 0) {
            const item = ytdlpSearchResults[ytdlpSearchActiveIndex];
            selectSearchResult(item.id, item.title);
          } else {
            searchYtDlpByTitle();
          }
          return;
        }

        if (!hasResults || !resultsVisible) return;

        if (event.key === "ArrowDown") {
          event.preventDefault();
          ytdlpSearchActiveIndex = Math.min(
            ytdlpSearchActiveIndex + 1,
            ytdlpSearchResults.length - 1,
          );
          renderSearchResults();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          ytdlpSearchActiveIndex = Math.max(ytdlpSearchActiveIndex - 1, 0);
          renderSearchResults();
        } else if (event.key === "Escape") {
          document.getElementById("d-search-results").style.display = "none";
          ytdlpSearchActiveIndex = -1;
        }
      }

      function selectSearchResult(videoId, title) {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        document.getElementById("d-url").value = url;
        document.getElementById("d-search-results").style.display = "none";
        document.getElementById("d-search-query").value = "";
        ytdlpSearchResults = [];
        ytdlpSearchActiveIndex = -1;
        showToast(t("toast.selected_title").replace("{title}", title), "success");
        
        if (typeof updateYtdlpPreview === "function") updateYtdlpPreview();
        if (typeof clearDuplicateWarning === "function") clearDuplicateWarning();
        if (typeof fetchYtDlpInfo === "function") fetchYtDlpInfo();
      }

      async function openPlaylistPickerView() {
        if (!pendingDownloadContext) return;
        document.getElementById("playlist-actions-view").style.display = "none";
        document.getElementById("playlist-picker-view").style.display = "flex";

        const container = document.getElementById("playlist-items-list");
        container.innerHTML =
          `<p style="text-align: center; color: var(--ink-dim); font-size: 0.75rem; margin-top: 3.5rem;">${t('modals.loading_titles', 'Lade Playlist-Titel vom Server...')}</p>`;

        try {
          const userLang = (window.navigator?.language || "de").split("-")[0];
          const res = await fetch(
            `/api/ytdlp-playlist-items?url=${encodeURIComponent(pendingDownloadContext.targetUrl)}&lang=${userLang}`,
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(
              err.detail || t("toast.playlist_fetch_error"),
            );
          }
          const items = await res.json();

          if (items.length === 0) {
            container.innerHTML =
              `<p style="text-align:center; color:var(--danger); font-size:0.75rem; margin-top:3rem;">${t('modals.no_titles_found', 'Keine Titel gefunden.')}</p>`;
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
          return showToast(t("toast.select_at_least_one_video"), "warn");

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
          if (expandBtn) expandBtn.style.display = "inline-flex";
          if (expandBtn) expandBtn.textContent = expanded
            ? t("label.expand_less")
            : t("label.expand_all_count").replace("{count}", extractedTitles.length);
        } else {
          if (expandBtn) expandBtn.style.display = "none";
        }
      }

      function toggleJobDetailsFilesExpand() {
        window.jobDetailsFilesExpanded = !window.jobDetailsFilesExpanded;
        renderJobDetailsFiles(window.jobDetailsExtractedTitles || [], 10);
      }

      let jobDetailsPollingTimer = null;
      let activeJobDetailsId = null;

      async function openJobDetails(jobId, isAutoRefresh = false) {
        activeJobDetailsId = jobId;

        // Bei jedem Aufruf/Refresh die frischesten Job-Daten vom Server laden
        try {
          const res = await fetch("/api/jobs");
          if (res.ok) {
            serverJobsCache = await res.json();
          }
        } catch (e) {}

        let job = clientJobs[jobId] || (serverJobsCache && serverJobsCache.find((j) => j.id === jobId));
        if (!job) return;

        document.getElementById("job-details-header").textContent =
          `Job: ${job.title}`;

        let plInfo = "";
        if (job.is_playlist && job.playlist_index && job.playlist_count) {
          plInfo = ` | <strong>Playlist:</strong> Video ${job.playlist_index} von ${job.playlist_count}`;
        }

        const processingMode =
          job.id && job.id.startsWith("local_") ? t("label.mode_client_wasm") : t("label.mode_server");

        document.getElementById("job-details-meta").innerHTML = `
                <strong>ID:</strong> ${job.id} | <strong>Modus:</strong> ${processingMode} | <strong>Tool:</strong> ${job.tool} | <strong>Status:</strong> ${job.status.toUpperCase()} | <strong>Fortschritt:</strong> ${job.progress}%${plInfo}
            `;

        const filesContainer = document.getElementById("job-details-files");
        const fileMap = new Map();

        if (job.logs && job.logs.length > 0) {
          job.logs.forEach((line) => {
            const match =
              line.match(
                /\[(?:download|ExtractAudio|Merger)\] Destination:\s*(?:\/[^\s]*\/)?(.+)/,
              ) ||
              line.match(
                /\[download\]\s*(?:\/[^\s]*\/)?(.+?)\s+has already been downloaded/,
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

        const expandBtn = document.getElementById(
          "job-details-files-expand-btn",
        );
        const headerEl = document.getElementById("job-details-files-header");

        if (extractedTitles.length > 0) {
          if (headerEl)
            headerEl.textContent = t("modals.extracted_tracks");
          renderJobDetailsFiles(extractedTitles, MIN_VISIBLE_TITLES);
        } else if (job.current_item_title) {
          if (headerEl) headerEl.textContent = t("label.current_loading_title");
          if (expandBtn) expandBtn.style.display = "none";
          filesContainer.innerHTML = `<div class="queue-item"><span style="font-weight:700;">🎵 ${escapeHtml(job.current_item_title)}</span></div>`;
        } else {
          if (headerEl) headerEl.textContent = t("label.processed_file");
          if (expandBtn) expandBtn.style.display = "none";
          filesContainer.innerHTML = `<div class="queue-item"><span style="font-weight:700;">📄 ${escapeHtml(job.title)}</span></div>`;
        }

        const logsContainer = document.getElementById("job-details-logs");
        if (logsContainer) {
          logsContainer.textContent =
            job.logs && job.logs.length > 0
              ? job.logs.join("\n")
              : t("toast.no_log_entries");
        }

        if (!isAutoRefresh) {
          window.jobDetailsFilesExpanded = false;
          openModal("job-details-modal");
        }

        // Live-Polling starten: Aktualisiert das Fenster alle 2 Sekunden automatisch, solange es offen ist
        if (!jobDetailsPollingTimer) {
          jobDetailsPollingTimer = setInterval(() => {
            const modal = document.getElementById("job-details-modal");
            if (modal && modal.style.display !== "none" && activeJobDetailsId) {
              openJobDetails(activeJobDetailsId, true);
            } else {
              clearInterval(jobDetailsPollingTimer);
              jobDetailsPollingTimer = null;
              activeJobDetailsId = null;
            }
          }, 2000);
        }
      }