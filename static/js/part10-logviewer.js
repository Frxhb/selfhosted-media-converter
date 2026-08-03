let logViewerLines = [];
      let logViewerAutoRefreshTimer = null;
      const LOGVIEWER_AUTOREFRESH_MS = 5000;

      async function refreshLogViewer() {
        const levelSelect = document.getElementById("logviewer-level-select");
        const linesSelect = document.getElementById("logviewer-lines-select");
        const statusEl = document.getElementById("logviewer-status");
        const level = levelSelect ? levelSelect.value : "app";
        const lines = linesSelect ? linesSelect.value : "300";

        try {
          const res = await fetch(`/api/logs?lines=${encodeURIComponent(lines)}&level=${encodeURIComponent(level)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          logViewerLines = data.lines || [];
          if (statusEl) {
            const now = new Date();
            const lang = currentLang === "de" ? "de-DE" : "en-US";
            const timeStr = now.toLocaleTimeString(lang);
            const linesSuffix = t(
              "logviewer.lines_suffix",
              currentLang === "de" ? "Zeilen" : "lines"
            );
            const updatedAt = t(
              "logviewer.updated_at",
              currentLang === "de" ? "Aktualisiert um" : "Updated at"
            );
            statusEl.textContent = `${data.file || ""} · ${logViewerLines.length} ${linesSuffix} · ${updatedAt} ${timeStr}`;
          }
        } catch (e) {
          showToast(t("toast.logviewer_load_failed", "Logs konnten nicht geladen werden."), "warn");
        }

        const downloadLink = document.getElementById("logviewer-download-link");
        if (downloadLink) {
          downloadLink.href = `/api/logs/download?level=${encodeURIComponent(level)}`;
        }

        renderLogViewer();
      }

      function renderLogViewer() {
        const consoleEl = document.getElementById("logviewer-console");
        if (!consoleEl) return;
        const searchEl = document.getElementById("logviewer-search");
        const query = searchEl ? searchEl.value.trim().toLowerCase() : "";

        const visibleLines = query
          ? logViewerLines.filter((line) => line.toLowerCase().includes(query))
          : logViewerLines;

        if (visibleLines.length === 0) {
          consoleEl.textContent = t("toast.no_log_entries", "Keine Log-Einträge vorhanden.");
          return;
        }

        consoleEl.textContent = visibleLines.join("\n");
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }

      function filterLogViewer() {
        renderLogViewer();
      }

      function onLogViewerAutoRefreshToggle() {
        const checkbox = document.getElementById("logviewer-autorefresh");
        if (logViewerAutoRefreshTimer) {
          clearInterval(logViewerAutoRefreshTimer);
          logViewerAutoRefreshTimer = null;
        }
        if (checkbox && checkbox.checked) {
          logViewerAutoRefreshTimer = setInterval(() => {
            const group = document.getElementById("group-logviewer");
            if (group && group.classList.contains("active")) {
              refreshLogViewer();
            }
          }, LOGVIEWER_AUTOREFRESH_MS);
        }
      }

      async function copyLogViewerToClipboard() {
        const text = logViewerLines.join("\n");
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
