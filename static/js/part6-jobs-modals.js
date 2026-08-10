      function closeModal(id) {
        document.getElementById(id).classList.remove("active");
      }

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          const openModalEl = document.querySelector(".modal-overlay.active");
          if (openModalEl) openModalEl.classList.remove("active");
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
          const searchEl = document.getElementById("job-search");
          if (searchEl) {
            e.preventDefault();
            searchEl.focus();
            searchEl.select();
          }
        }
      });

      async function loadJobs() {
        try {
          const res = await fetch("/api/jobs");
          serverJobsCache = await res.json();
          renderJobsCombined();
        } catch (e) {}
      }

      let jobSearchQuery = "";

      function filterJobList() {
        jobSearchQuery = document
          .getElementById("job-search")
          .value.toLowerCase();
        renderJobsCombined();
      }

      function statusBadgeStyle(status) {
        if (status === "running")
          return "background: var(--signal-dim); color: var(--signal);";
        if (status === "paused")
          return "background: rgba(245, 196, 81, 0.15); color: var(--warn);";
        if (status === "completed")
          return "background: var(--ok-dim); color: var(--ok);";
        if (status === "failed")
          return "background: var(--danger-dim); color: var(--danger);";
        if (status === "cancelled")
          return "background: var(--surface-sunken); color: var(--ink-faint);";
        return "background: var(--surface-sunken); color: var(--ink-dim);";
      }

      function renderJobsCombined() {
        const container = document.getElementById("job-list");
        const allClientJobs = Object.values(clientJobs);
        const totalCount = serverJobsCache.length + allClientJobs.length;

        document.getElementById("queue-count").textContent =
          `${totalCount} ${t('queue.jobs', 'Jobs')}`;

        const q = jobSearchQuery;
        const matches = (title) => !q || title.toLowerCase().includes(q);

        const visibleClient = allClientJobs.filter((j) => matches(j.title));
        const visibleServer = serverJobsCache.filter((j) => matches(j.title));

        if (totalCount === 0) {
          container.innerHTML =
            `<p style="text-align: center; color: var(--ink-dim); font-size: 0.8rem; margin-top: 3rem;">${t('queue.empty', 'Warteschlange leer')}</p>`;
          return;
        }
        if (visibleClient.length === 0 && visibleServer.length === 0) {
          container.innerHTML =
            `<p style="text-align: center; color: var(--ink-dim); font-size: 0.8rem; margin-top: 3rem;">${t('queue.no_jobs_found', 'Keine Jobs gefunden.')}</p>`;
          return;
        }

        container.innerHTML = "";

        visibleClient.forEach((j) => {
          container.innerHTML += renderJobCard(j, { local: true });
        });

        visibleServer.forEach((j) => {
          container.innerHTML += renderJobCard(j, {
            local: false,
            draggable: j.status === "pending",
          });
        });

        attachQueueDragHandlers();
      }

      function renderJobCard(j, { local, draggable = false } = {}) {
        let rawTitle = j.title || "";
        let stageBadge = "";

        // Extrahieren der Pipeline-Stufen-Info z. B. [Pipeline-Name – Stufe 1/3]
        const stageMatch =
          rawTitle.match(/\s*\[([^\]]+–\s*Stufe\s*\d+\/\d+)\]$/i) ||
          rawTitle.match(/\s*\[(Stufe\s*\d+\/\d+)\]$/i);
        if (stageMatch) {
          const stageText = stageMatch[1];
          rawTitle = rawTitle.replace(stageMatch[0], "").trim();
          stageBadge = `<span class="status-badge" style="background:var(--signal-dim); color:var(--signal); border:1px solid rgba(255,138,61,0.25); flex-shrink:0; font-family:var(--font-mono);" title="${escapeHtml(stageText)}">${escapeHtml(stageText)}</span>`;
        }

        let speedDisplay = "";
        if (!local && j.logs) {
          const speedLine = j.logs
            .slice()
            .reverse()
            .find((l) => l.includes("speed=") || l.includes("at "));
          if (speedLine) {
            const match =
              speedLine.match(/speed=\s*([\d.]+)x/) ||
              speedLine.match(/at\s+([\d\.]+\s*[kMG]?i?B\/s)/);
            if (match)
              speedDisplay =
                match[1] + (match[0].includes("speed=") ? "x" : "");
          }
        }

        const cancelFn = local ? "cancelClientJob" : "cancelJob";
        const canCancel = j.status === "running" || j.status === "pending" || j.status === "paused";
        const canRetry = !local && j.status === "failed";
        // Pause/Resume gibt es nur für Server-Jobs (client-seitige WASM-Jobs haben keinen
        // Server-Subprozess, den man per SIGSTOP anhalten könnte) und nicht für laufende
        // Live-Mitschnitte (die haben mit "Aufnahme beenden" bereits ihren eigenen,
        // spezielleren Abschluss-Mechanismus).
        const canPause = !local && !j.is_live_stream && (j.status === "running" || j.status === "pending");
        const canResume = !local && j.status === "paused";
        const retryBadge =
          j.retry_count > 0
            ? `<span title="${j.retry_count} automatische Neuversuche" style="font-size:0.6rem; color:var(--ink-faint); font-family:var(--font-mono);">↻${j.retry_count}</span>`
            : "";

        const modeBadge = local
          ? `<span style="font-size:0.6rem; background:var(--signal-dim); color:var(--signal); padding:0.1rem 0.35rem; border-radius:0.2rem; font-family:var(--font-mono); flex-shrink:0;">CLIENT (WASM)</span>`
          : `<span style="font-size:0.6rem; background:var(--surface-sunken); border:1px solid var(--line); color:var(--ink-dim); padding:0.1rem 0.35rem; border-radius:0.2rem; font-family:var(--font-mono); flex-shrink:0;">SERVER</span>`;

        let playlistBadge = "";
        if (j.is_playlist) {
          const idxText =
            j.playlist_index && j.playlist_count
              ? `${j.playlist_index}/${j.playlist_count}`
              : "Playlist";
          playlistBadge = `<span style="font-size:0.6rem; background:var(--signal-dim); color:var(--signal); padding:0.1rem 0.35rem; border-radius:0.2rem; font-family:var(--font-mono); flex-shrink:0;">📋 ${idxText}</span>`;
        }

        const isLiveRunning = j.is_live_stream && j.status === "running";
        const liveBadge = j.is_live_stream
          ? `<span style="font-size:0.6rem; background:#dc2626; color:#fff; padding:0.1rem 0.35rem; border-radius:0.2rem; font-family:var(--font-mono); flex-shrink:0;">🔴 ${t("queue.live_badge", "LIVE")}</span>`
          : "";

        return `
                <div class="job-card" data-job-id="${j.id}" ${draggable ? 'draggable="true"' : ""} style="background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 0.65rem; display: flex; flex-direction: column; gap: 0.35rem; ${draggable ? "cursor: grab;" : ""}; min-width: 0;">
                    <div style="display:flex; align-items:flex-start; gap: 0.4rem; min-width: 0;">
                        ${draggable ? '<span class="drag-handle" style="color:var(--ink-faint); flex-shrink:0; cursor:grab; margin-top:0.1rem;">⠿</span>' : ""}
                        <span style="font-weight: 700; font-size: 0.82rem; line-height: 1.3; flex: 1; min-width: 0; word-break: break-word;" title="${escapeHtml(j.title)}">${escapeHtml(rawTitle)}</span>
                        <span class="status-badge" style="${statusBadgeStyle(j.status)} flex-shrink:0;">${j.status}</span>
                    </div>
                    <div style="display:flex; flex-wrap:wrap; align-items:center; gap: 0.3rem;">
                        ${stageBadge}
                        ${modeBadge}
                        ${playlistBadge}
                        ${liveBadge}
                        ${speedDisplay ? `<span id="speed-${j.id}" style="font-size:0.65rem; color:var(--signal); font-weight:700; font-family:var(--font-mono); flex-shrink:0;">${speedDisplay}</span>` : `<span id="speed-${j.id}" style="display:none;"></span>`}
                        ${retryBadge}
                    </div>
                    ${
                      j.is_playlist && j.current_item_title
                        ? `<div style="font-size:0.72rem; color:var(--ink-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">▶ ${escapeHtml(j.current_item_title)}</div>`
                        : ""
                    }
                    <div class="meter-bar"><div id="pbar-${j.id}" class="meter-fill" style="width: ${j.progress}%;"></div></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size: 0.68rem; color: var(--ink-dim); font-family:var(--font-mono); min-width: 0;">
                        <span id="eta-${j.id}" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1;">${j.eta}</span>
                        <div style="display:flex; gap:0.35rem; align-items:center; flex-shrink:0;">
                            <button onclick="openJobDetails('${j.id}')" class="btn btn-secondary btn-sm">${t('common.details', 'Details')}</button>
                            ${canRetry ? `<button onclick="retryJob('${j.id}')" class="btn btn-primary btn-sm">${t('common.retry', 'Wiederholen')}</button>` : ""}
                            ${isLiveRunning ? `<button onclick="stopLiveRecording('${j.id}')" class="btn btn-primary btn-sm">⏹ ${t('queue.stop_live_btn', 'Aufnahme beenden')}</button>` : ""}
                            ${canPause ? `<button onclick="pauseJob('${j.id}')" class="btn btn-secondary btn-sm" title="${t('queue.pause_hint', 'Job anhalten, ohne ihn zu verlieren')}">⏸ ${t('common.pause', 'Pausieren')}</button>` : ""}
                            ${canResume ? `<button onclick="resumeJob('${j.id}')" class="btn btn-primary btn-sm">▶ ${t('common.resume', 'Fortsetzen')}</button>` : ""}
                            ${canCancel ? `<button onclick="${cancelFn}('${j.id}')" class="btn btn-danger btn-sm">${t('common.cancel', 'Abbrechen')}</button>` : ""}
                        </div>
                    </div>
                </div>
            `;
      }

      let dragSourceId = null;

      function attachQueueDragHandlers() {
        const cards = document.querySelectorAll(
          '#job-list .job-card[draggable="true"]',
        );
        cards.forEach((card) => {
          card.addEventListener("dragstart", (e) => {
            dragSourceId = card.getAttribute("data-job-id");
            card.style.opacity = "0.4";
            e.dataTransfer.effectAllowed = "move";
          });
          card.addEventListener("dragend", () => {
            card.style.opacity = "1";
            dragSourceId = null;
          });
          card.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          });
          card.addEventListener("drop", (e) => {
            e.preventDefault();
            const targetId = card.getAttribute("data-job-id");
            if (!dragSourceId || dragSourceId === targetId) return;
            reorderPendingJobsInDom(dragSourceId, targetId);
          });
        });
      }

      async function reorderPendingJobsInDom(sourceId, targetId) {
        const container = document.getElementById("job-list");
        const sourceEl = container.querySelector(`[data-job-id="${sourceId}"]`);
        const targetEl = container.querySelector(`[data-job-id="${targetId}"]`);
        if (!sourceEl || !targetEl) return;

        const cards = Array.from(
          container.querySelectorAll('.job-card[draggable="true"]'),
        );
        const sourceIdx = cards.indexOf(sourceEl);
        const targetIdx = cards.indexOf(targetEl);
        if (sourceIdx < targetIdx) {
          targetEl.after(sourceEl);
        } else {
          targetEl.before(sourceEl);
        }

        const newOrder = Array.from(
          container.querySelectorAll('.job-card[draggable="true"]'),
        ).map((el) => el.getAttribute("data-job-id"));

        try {
          const res = await fetch("/api/jobs/queue/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: newOrder }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showToast(t("toast.queue_resorted"), "success", 2200);
        } catch (e) {
          showToast(t("toast.sort_save_failed"), "warn");
          loadJobs();
        }
      }

      async function retryJob(jobId) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/retry`, {
            method: "POST",
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          const job = await res.json();
          showToast(t("toast.job_retrying").replace("{title}", job.title), "success");
          loadJobs();
        } catch (e) {
          showToast(t("toast.retry_failed") + e.message, "warn");
        }
      }

      async function clearCompletedServerJobs() {
        await fetch("/api/jobs/completed", { method: "DELETE" });
        for (const id in clientJobs) {
          if (
            ["completed", "failed", "cancelled"].includes(clientJobs[id].status)
          )
            delete clientJobs[id];
        }
        loadJobs();
      }

      function updateJobProgressUI(jobId, progress, eta, logLine) {
        const pbar = document.getElementById(`pbar-${jobId}`);
        const etaEl = document.getElementById(`eta-${jobId}`);
        const speedEl = document.getElementById(`speed-${jobId}`);

        if (pbar) pbar.style.width = `${progress}%`;
        if (etaEl) etaEl.textContent = eta;
        if (logLine && speedEl) {
          const ffmpegMatch = logLine.match(/speed=\s*([\d.]+)x/);
          const ytdlpMatch = logLine.match(/at\s+([\d.]+\s*[kMG]?i?B\/s)/);
          if (ffmpegMatch) {
            speedEl.textContent = ffmpegMatch[1] + "x";
            speedEl.style.display = "";
          } else if (ytdlpMatch) {
            speedEl.textContent = ytdlpMatch[1];
            speedEl.style.display = "";
          }
        }
      }

      async function stopLiveRecording(jobId) {
        try {
          showToast(t("toast.live_stopping"), "info", 4000);
          const res = await fetch(`/api/jobs/${jobId}/stop-live`, { method: "POST" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
        } catch (e) {
          showToast(t("toast.live_stop_failed") + e.message, "warn");
        }
        loadJobs();
      }

      async function cancelJob(jobId) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
        } catch (e) {
          showToast(t("toast.cancel_failed") + e.message, "warn");
        }
        loadJobs();
      }

      async function pauseJob(jobId) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/pause`, { method: "POST" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          showToast(t("toast.job_paused", "Job pausiert."), "success");
        } catch (e) {
          showToast(t("toast.pause_failed", "Pausieren fehlgeschlagen: ") + e.message, "warn");
        }
        loadJobs();
      }

      async function resumeJob(jobId) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/resume`, { method: "POST" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          showToast(t("toast.job_resumed", "Job fortgesetzt."), "success");
        } catch (e) {
          showToast(t("toast.resume_failed", "Fortsetzen fehlgeschlagen: ") + e.message, "warn");
        }
        loadJobs();
      }

      async function cancelAllJobs() {
        if (!confirm(t("confirm.cancel_all_jobs"))) return;
        try {
          const res = await fetch("/api/jobs/cancel-all", { method: "POST" });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          const data = await res.json();
          showToast(t("toast.jobs_cancelled").replace("{count}", data.count || 0), "info");
        } catch (e) {
          showToast(t("toast.cancel_failed") + e.message, "warn");
        }
        loadJobs();
      }

      setInterval(fetchStats, 4000);

      let currentTagsEditFile = null;

