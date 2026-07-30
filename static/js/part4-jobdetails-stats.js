async function fetchYtDlpInfo() {
        const url = sanitizeUrl(document.getElementById("d-url").value);
        if (!url) return showToast("Bitte URL eingeben.", "warn");

        const btn = document.getElementById("d-fetch-btn");
        btn.disabled = true;
        btn.textContent = "⏳...";
        clearDuplicateWarning();

        try {
          // --- NEU: Browser-Sprache auslesen ---
          const userLang = (window.navigator?.language || "de").split("-")[0];
          
          // --- NEU: &lang= an die Backend-URL anhängen ---
          const res = await fetch(
            `/api/ytdlp-info?url=${encodeURIComponent(url)}&lang=${userLang}`,
          );
          
          const info = await res.json();
          document.getElementById("d-info-title").textContent =
            info.title || "Unbekannt";
          document.getElementById("d-info-uploader").textContent =
            info.uploader || "Unbekannt";
          document.getElementById("d-info-duration").textContent =
            info.duration || "Unbekannt";
          document.getElementById("d-info-thumb").src = info.thumbnail || "";
          document.getElementById("d-info-preview").style.display = "flex";

          checkLibraryForDuplicateTitle(info.title);
        } catch (e) {
          clearDuplicateWarning();
          showToast(e.message, "warn");
        } finally {
          btn.disabled = false;
          btn.textContent = "🔍 Fetch Info";
        }
      }

      function clearDuplicateWarning() {
        const warningBox = document.getElementById("d-duplicate-warning");
        if (warningBox) warningBox.style.display = "none";
      }

      function normalizeForDuplicateMatch(str) {
        return (str || "")
          .toLowerCase()
          .replace(/\.[^/.]+$/, "") // Dateiendung entfernen (falls Dateiname statt Titel übergeben wurde)
          .replace(/[^\p{L}\p{N}]+/gu, " ") // alles außer Buchstaben/Zahlen zu Leerzeichen (Unicode-fähig für Umlaute etc.)
          .trim()
          .replace(/\s+/g, " ");
      }

      async function checkLibraryForDuplicateTitle(title) {
        const warningBox = document.getElementById("d-duplicate-warning");
        if (!warningBox) return;
        warningBox.style.display = "none";
        if (!title) return;

        try {
          const res = await fetch("/api/files/outputs");
          if (res.ok) {
            outputLibraryFiles = await res.json();
          }
        } catch (e) {}

        const normalizedTitle = normalizeForDuplicateMatch(title);
        if (normalizedTitle.length < 4) return; // zu kurz für einen sinnvollen Vergleich

        const titleWords = new Set(
          normalizedTitle.split(" ").filter((w) => w.length > 2),
        );
        if (titleWords.size === 0) return;

        const matches = outputLibraryFiles.filter((f) => {
          const normalizedName = normalizeForDuplicateMatch(f.name);
          if (!normalizedName) return false;
          // Exakter Substring-Treffer (Titel steckt komplett im Dateinamen oder umgekehrt)
          if (
            normalizedName.includes(normalizedTitle) ||
            normalizedTitle.includes(normalizedName)
          ) {
            return true;
          }
          // Sonst: Wortüberlappung - mind. 70% der bedeutungstragenden Titel-Wörter (>2 Zeichen)
          // müssen auch im Dateinamen vorkommen. Bewusst grobe Heuristik statt exaktem Vergleich,
          // da Dateinamen durch %(title)s oft leicht abweichen (Sonderzeichen, Kanal-Suffixe etc.)
          const nameWords = new Set(normalizedName.split(" "));
          let overlap = 0;
          titleWords.forEach((w) => {
            if (nameWords.has(w)) overlap++;
          });
          return overlap / titleWords.size >= 0.7;
        });

        if (matches.length > 0) {
          const preview = matches
            .slice(0, 3)
            .map((f) => escapeHtml(f.name))
            .join("<br>");
          warningBox.innerHTML = `⚠️ Möglicherweise bereits in der Bibliothek vorhanden:<br>${preview}${matches.length > 3 ? `<br>… und ${matches.length - 3} weitere` : ""}`;
          warningBox.style.display = "block";
        }
      }

      async function fetchStats() {
        try {
          const res = await fetch("/api/stats");
          const data = await res.json();
          const s = data.job_stats;

          document.getElementById("st-cpu-val-meter").textContent =
            `${data.cpu_percent}%`;
          document.getElementById("st-cpu-bar").style.width =
            `${data.cpu_percent}%`;
          const wsEl = document.getElementById("ws-status");
          if (wsEl && !wsEl.classList.contains("offline")) {
            setConnectionStatus(data.cpu_percent >= 85 ? "busy" : "online");
          }

          document.getElementById("st-ram-val").textContent =
            `${data.ram_used_gb} GB / ${data.ram_total_gb} GB`;
          document.getElementById("st-ram-bar").style.width =
            `${data.ram_percent}%`;

          if (data.load_avg) {
            document.getElementById("st-load1").textContent =
              data.load_avg.load1.toFixed(2);
            document.getElementById("st-load5").textContent =
              data.load_avg.load5.toFixed(2);
            document.getElementById("st-load15").textContent =
              data.load_avg.load15.toFixed(2);
          }

          document.getElementById("st-disk-in-val").textContent =
            `${data.disk_inputs.used_gb} GB / ${data.disk_inputs.total_gb} GB`;
          document.getElementById("st-disk-in-pct").textContent =
            `${data.disk_inputs.percent}%`;
          document.getElementById("st-disk-in-bar").style.width =
            `${data.disk_inputs.percent}%`;
          document.getElementById("st-disk-in-free").textContent =
            `${data.disk_inputs.free_gb} GB`;

          document.getElementById("st-disk-out-val").textContent =
            `${data.disk_outputs.used_gb} GB / ${data.disk_outputs.total_gb} GB`;
          document.getElementById("st-disk-out-pct").textContent =
            `${data.disk_outputs.percent}%`;
          document.getElementById("st-disk-out-bar").style.width =
            `${data.disk_outputs.percent}%`;
          document.getElementById("st-disk-out-free").textContent =
            `${data.disk_outputs.free_gb} GB`;

          updateDiskWarningBanner(
            data.disk_outputs.free_gb,
            data.disk_outputs.percent,
          );
          colorizeMeter("st-disk-out-bar", data.disk_outputs.percent);
          colorizeMeter("st-disk-in-bar", data.disk_inputs.percent);
          colorizeMeter("st-ram-bar", data.ram_percent);
          colorizeMeter("st-cpu-bar", data.cpu_percent);

          document.getElementById("st-active-jobs").textContent =
            data.active_jobs;
          document.getElementById("st-pending-jobs").textContent =
            data.pending_jobs;

          document.getElementById("st-total-gb").textContent =
            `${s.total_gb} GB`;
          document.getElementById("st-total-hours").textContent =
            `${s.total_hours} Std`;
          document.getElementById("st-rate").textContent = `${s.success_rate}%`;

          document.getElementById("st-dl-count").textContent = s.downloads;
          document.getElementById("st-dl-gb").textContent =
            `${s.download_gb} GB`;
          document.getElementById("st-dl-hours").textContent =
            `${s.download_hours} Std`;
          document.getElementById("st-conv-count").textContent = s.conversions;
        } catch (e) {}
      }

      function colorizeMeter(elId, pct) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.classList.remove("ok-fill", "warn-fill", "danger-fill");
        if (pct >= 90) el.classList.add("danger-fill");
        else if (pct >= 75) el.classList.add("warn-fill");
      }

      let lastDiskWarningState = null;
      function updateDiskWarningBanner(freeGb, pct) {
        const banner = document.getElementById("disk-warning-banner");
        const text = document.getElementById("disk-warning-text");
        if (!banner || !text) return;

        const threshold =
          configuredMinDiskGb != null ? configuredMinDiskGb : 2.0;
        const isLow = freeGb < threshold || pct >= 95;

        if (isLow) {
          text.textContent = `Nur noch ${freeGb.toFixed(1)} GB frei auf /media/outputs. Neue Jobs werden blockiert, sobald der Wert unter ${threshold} GB fällt. Lösche nicht mehr benötigte Dateien in der Bibliothek.`;
          banner.style.display = "flex";
        } else {
          banner.style.display = "none";
        }
        lastDiskWarningState = isLow;
      }

      async function resetStatsDatabase() {
        if (!confirm("Alle Statistiken zurücksetzen?")) return;
        await fetch("/api/stats/reset", { method: "POST" });
        fetchStats();
        closeModal("settings-modal");
      }

      async function refreshOutputFiles() {
        try {
          const res = await fetch("/api/files/outputs");
          outputLibraryFiles = await res.json();
          renderOutputLibrary();
        } catch (e) {}
      }

      function filterLibraryCategory(cat) {
        activeLibraryCategory = cat;
        document
          .querySelectorAll(".lib-cat-btn")
          .forEach((b) => b.classList.remove("active"));
        document.querySelector(`[data-cat="${cat}"]`).classList.add("active");
        renderOutputLibrary();
      }

      function filterOutputLibrary() {
        renderOutputLibrary();
      }

      function renderOutputLibrary() {
        const tbody = document.getElementById("library-tbody");
        const searchVal = document
          .getElementById("lib-search")
          .value.toLowerCase();
        outputLibraryFiles.sort(
          (a, b) => new Date(b.mtime) - new Date(a.mtime),
        );
        let filtered = outputLibraryFiles.filter((f) => {
          const matchCat =
            activeLibraryCategory === "all" ||
            f.category === activeLibraryCategory;
          return matchCat && f.name.toLowerCase().includes(searchVal);
        });
        if (filtered.length === 0) {
          tbody.innerHTML =
            '<tr><td colspan="5" style="text-align:center; color:var(--ink-dim); padding:2rem;">Keine Medien gefunden.</td></tr>';
          return;
        }
        tbody.innerHTML = "";
        filtered.forEach((f) => {
          const dateObj = new Date(f.mtime);
          const formattedDate = dateObj.toLocaleString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          const cat = (f.category || "").toLowerCase();
          const isPlayable = ["video", "audio", "image"].includes(cat);

          const encForAttr = (s) =>
            encodeURIComponent(s || "").replace(/'/g, "%27");
          const encPath = encForAttr(f.rel_path);
          const encCat = encForAttr(cat);
          const encName = encForAttr(f.name);
          tbody.innerHTML += `
            <tr>
                <td><input type="checkbox" class="lib-file-check" data-path="${escapeHtml(f.rel_path)}" onchange="updateLibraryBulkCounter()"></td>
                <td>
                    <div class="lib-title-cell">
                        <span class="lib-title-text" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                        <div class="lib-actions-row">
                            ${isPlayable ? `<button onclick="playMediaPreview('${encPath}', '${encCat}', '${encName}')" class="btn btn-secondary btn-sm" title="Abspielen">▶️</button>` : ""}
                            ${isPlayable ? `<button onclick="openTagsEditor('${f.rel_path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')" class="btn btn-secondary btn-sm" title="Metadaten bearbeiten">🏷️</button>` : ""}
                            <a href="/api/files/download/${encodeURIComponent(f.rel_path)}" download class="btn btn-secondary btn-sm" title="Herunterladen">💾</a>
                            <button onclick="deleteOutputFile('${f.rel_path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')" class="btn btn-danger btn-sm" title="Löschen">
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                            </button>
                        </div>
                    </div>
                </td>
                <td><span class="status-badge" style="background:var(--surface-sunken); border:1px solid var(--line); color:var(--ink-dim);">${f.category.toUpperCase()}</span></td>
                <td>${f.size_mb} MB</td>
                <td><small style="color:var(--ink-dim); white-space:nowrap;">${formattedDate}</small></td>
            </tr>
        `;
        });
        updateLibraryBulkCounter();
      }

      function playMediaPreview(encPath, encCat, encName, source = "outputs") {
        const relPath = decodeURIComponent(encPath);
        const category = decodeURIComponent(encCat);
        const name = decodeURIComponent(encName);

        const container = document.getElementById("player-container");
        const titleEl = document.getElementById("player-modal-title");
        titleEl.textContent = `Vorschau: ${name}`;

        const safeUrlPath = relPath
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        const url =
          source === "inputs"
            ? `/api/files/inputs/download/${safeUrlPath}`
            : `/api/files/download/${safeUrlPath}`;

        if (category === "video") {
          container.innerHTML = `<video controls autoplay style="max-width:100%; max-height:70vh; width:100%;"><source src="${url}"></video>`;
        } else if (category === "audio") {
          container.innerHTML = `<div style="padding:2rem; width:100%;"><audio controls autoplay style="width:100%;"><source src="${url}"></audio></div>`;
        } else if (category === "image") {
          container.innerHTML = `<img src="${url}" style="max-width:100%; max-height:70vh; object-fit:contain; border-radius:var(--radius-sm);">`;
        } else {
          container.innerHTML = `<div style="padding:2rem; color:var(--ink-dim);">Vorschau für diesen Dateityp nicht verfügbar.</div>`;
        }
        openModal("player-modal");
      }

      function previewInputFile() {
        const select = document.getElementById("global-file-select");
        const path = select.value;
        if (!path) return showToast("Wähle zuerst eine Datei aus.", "warn");

        const name = path.split("/").pop();
        const ext = name.split(".").pop().toLowerCase();

        // Einfache Kategorie-Bestimmung anhand der Endung
        let category = "video";
        if (["mp3", "m4a", "wav", "flac", "opus", "aac", "ogg"].includes(ext))
          category = "audio";
        if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"].includes(ext))
          category = "image";

        const isInput = activeFileSource === "inputs";
        const sourcePrefix = isInput ? "/media/inputs/" : "/media/outputs/";
        const relPath = path.replace(sourcePrefix, "");

        const encPath = encodeURIComponent(relPath).replace(/'/g, "%27");
        const encCat = encodeURIComponent(category);
        const encName = encodeURIComponent(name).replace(/'/g, "%27");

        playMediaPreview(encPath, encCat, encName, activeFileSource);
      }

      function closePlayerModal() {
        document.getElementById("player-container").innerHTML = "";
        closeModal("player-modal");
      }

      function updateLibraryBulkCounter() {
        const count = document.querySelectorAll(
          ".lib-file-check:checked",
        ).length;
        const zipBtn = document.getElementById("btn-bulk-zip");
        const delBtn = document.getElementById("btn-bulk-del");

        if (zipBtn)
          zipBtn.textContent =
            count > 0 ? `${count} Ausgewählte als ZIP` : "Ausgewählte als ZIP";
        if (delBtn)
          delBtn.textContent =
            count > 0 ? `${count} Ausgewählte löschen` : "Ausgewählte löschen";
      }

      function toggleSelectAllLibraryItems(checked) {
        document
          .querySelectorAll(".lib-file-check")
          .forEach((c) => (c.checked = checked));
        updateLibraryBulkCounter();
      }

      async function deleteBulk() {
        const checks = document.querySelectorAll(".lib-file-check:checked");
        if (checks.length === 0)
          return showToast("Bitte wähle Dateien aus.", "warn");
        if (
          !confirm(
            `Wirklich ${checks.length} Datei(en) unwiderruflich löschen?`,
          )
        )
          return;

        const btn = document.getElementById("btn-bulk-del");
        const originalText = btn.textContent;
        btn.disabled = true;

        let succeeded = 0;
        const failed = [];

        for (const c of checks) {
          const relPath = c.getAttribute("data-path");
          btn.textContent = `Lösche... (${succeeded + failed.length + 1}/${checks.length})`;
          try {
            const res = await fetch(
              `/api/files/outputs?rel_path=${encodeURIComponent(relPath)}`,
              { method: "DELETE" },
            );
            if (res.ok) succeeded++;
            else failed.push(relPath);
          } catch (e) {
            failed.push(relPath);
          }
        }

        btn.textContent = originalText;
        btn.disabled = false;

        if (failed.length > 0) {
          alert(
            `${succeeded} Datei(en) gelöscht, ${failed.length} fehlgeschlagen:\n${failed.slice(0, 10).join("\n")}${failed.length > 10 ? "\n..." : ""}`,
          );
        }
        await refreshOutputFiles();

        document.getElementById("lib-select-all").checked = false;
        updateLibraryBulkCounter();
      }

      async function downloadBulkZip() {
        const checks = document.querySelectorAll(".lib-file-check:checked");
        if (checks.length === 0)
          return showToast("Bitte wähle Dateien aus.", "warn");

        const btn = document.getElementById("btn-bulk-zip");
        const originalText = btn.textContent;
        btn.textContent = "⏳ Erstelle ZIP...";
        btn.disabled = true;

        const selectedFiles = Array.from(checks).map((c) =>
          c.getAttribute("data-path"),
        );

        try {
          const res = await fetch("/api/files/outputs/zip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(selectedFiles),
          });
          if (!res.ok) throw new Error("ZIP Fehlschlag");
          const blob = await res.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `mcp_export_${Date.now()}.zip`;
          a.click();
        } catch (e) {
          alert(e);
        } finally {
          btn.textContent = originalText;
          btn.disabled = false;

          document.getElementById("lib-select-all").checked = false;
          toggleSelectAllLibraryItems(false);
        }
      }

      async function deleteOutputFile(relPath) {
        if (
          !confirm(
            `"${relPath}" wirklich löschen? Das kann nicht rückgängig gemacht werden.`,
          )
        )
          return;
        try {
          const res = await fetch(
            `/api/files/outputs?rel_path=${encodeURIComponent(relPath)}`,
            { method: "DELETE" },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          await refreshOutputFiles();
        } catch (e) {
          alert("Löschen fehlgeschlagen: " + e.message);
        }
      }

      function addFileToQueue(tab, fileObj) {
        if (!tabQueues[tab]) return;
        if (!tabQueues[tab].some((f) => f.path === fileObj.path)) {
          tabQueues[tab].push(fileObj);
          renderTabQueue(tab);
          updateAllPreviews();
        }
      }

      function renderTabQueue(tab) {
        const container = document.getElementById(`${tab}-queue`);
        if (!container) return;
        const list = tabQueues[tab];
        if (list.length === 0) {
          container.innerHTML =
            `<p style="text-align:center; color:var(--ink-dim); font-size:0.75rem; margin-top:2rem;">${t('queue.tab_empty', 'Noch keine Dateien in dieser Warteschlange.')}</p>`;
          return;
        }
        container.innerHTML = "";
        list.forEach((f, idx) => {
          container.innerHTML += `
                    <div class="queue-item">
                        <span>📄 ${escapeHtml(f.name)}</span>
                        <button onclick="removeFromTabQueue('${tab}', ${idx})" style="background:none; border:none; color:var(--danger); cursor:pointer; font-weight:bold;">✕</button>
                    </div>
                `;
        });
      }
