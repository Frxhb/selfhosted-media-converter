      async function refreshPipelines() {
        try {
          const res = await fetch("/api/pipelines");
          pipelinesCache = await res.json();
        } catch (e) {
          showToast("Pipelines konnten nicht geladen werden.", "warn");
          pipelinesCache = [];
        }
        if (outputLibraryFiles.length === 0) {
          await refreshOutputFiles();
        }
        renderPipelineList();
        renderPipelineRunSelect();
      }

      function renderPipelineList() {
        const container = document.getElementById("pipeline-list");
        if (!container) return;
        if (pipelinesCache.length === 0) {
          container.innerHTML = `<div style="color:var(--ink-dim); font-size:0.85rem;">Noch keine Pipelines angelegt.</div>`;
          return;
        }
        container.innerHTML = pipelinesCache
          .map((p) => {
            const chain = p.stages
              .map((st) => {
                const def = STAGE_TYPES[st.job_type];
                const shortLabel = def
                  ? def.label.replace(/^\S+\s/, "")
                  : st.job_type;
                return `<span class="status-badge" style="background:var(--surface-sunken); border:1px solid var(--line); color:var(--ink-dim);">${escapeHtml(shortLabel)}</span>`;
              })
              .join('<span style="color:var(--ink-dim);">→</span>');

            return `
                <div class="card" style="padding:0.7rem 0.9rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                    <div>
                        <div style="font-weight:600;">${escapeHtml(p.name)}</div>
                        <div style="font-size:0.75rem; margin-top:0.35rem; display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                            ${chain}
                        </div>
                        ${p.description ? `<div style="font-size:0.72rem; color:var(--ink-dim); margin-top:0.35rem;">${escapeHtml(p.description)}</div>` : ""}
                    </div>
                    <div style="display:flex; gap:0.4rem;">
                        <button onclick="openPipelineEditor('${p.id}')" class="btn btn-secondary" style="padding:0.3rem 0.7rem;">Bearbeiten</button>
                        <button onclick="deletePipeline('${p.id}')" class="btn btn-danger" style="padding:0.3rem 0.7rem;">Löschen</button>
                    </div>
                </div>`;
          })
          .join("");
      }

      function renderPipelineRunSelect() {
        const sel = document.getElementById("pl-run-select");
        if (!sel) return;
        sel.innerHTML = pipelinesCache
          .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
          .join("");
        onPipelineRunSelectChange();
      }

      function onPipelineRunSelectChange() {
        const pipelineId = document.getElementById("pl-run-select").value;
        const pipeline = pipelinesCache.find((p) => p.id === pipelineId);
        const isDownloadStart = !!(
          pipeline &&
          pipeline.stages.length &&
          pipeline.stages[0].job_type === "download"
        );

        const label = document.getElementById("pl-run-input-label");
        const fileSel = document.getElementById("pl-run-file-select");
        const urlInput = document.getElementById("pl-run-url");
        if (!label || !fileSel || !urlInput) return;

        if (isDownloadStart) {
          label.textContent = "Video/Playlist-URL:";
          fileSel.style.display = "none";
          urlInput.style.display = "";
        } else {
          label.textContent = "Eingabedatei:";
          fileSel.style.display = "";
          urlInput.style.display = "none";
          fileSel.innerHTML = (
            outputLibraryFiles.length ? outputLibraryFiles : []
          )
            .map(
              (f) =>
                `<option value="${f.path}">${escapeHtml(f.rel_path || f.name)}</option>`,
            )
            .join("");
        }
      }

      async function runSelectedPipeline() {
        const pipelineId = document.getElementById("pl-run-select").value;
        const pipeline = pipelinesCache.find((p) => p.id === pipelineId);
        const isDownloadStart = !!(
          pipeline &&
          pipeline.stages.length &&
          pipeline.stages[0].job_type === "download"
        );

        const inputValue = isDownloadStart
          ? document.getElementById("pl-run-url").value.trim()
          : document.getElementById("pl-run-file-select").value;

        if (!pipelineId || !inputValue) {
          showToast(
            isDownloadStart
              ? "Bitte Pipeline und URL angeben."
              : "Bitte Pipeline und Eingabedatei wählen.",
            "warn",
          );
          return;
        }

        let extractedTitle = null;
        const previewTitleEl = document.getElementById("d-info-title");
        if (previewTitleEl) {
          const raw = previewTitleEl.textContent
            ? previewTitleEl.textContent.trim()
            : "";
          if (raw && raw !== "-") {
            extractedTitle = raw;
          }
        }

        // Falls es eine Download-Pipeline ist und kein Titel vorhanden ist: Automatisch ermitteln
        if (isDownloadStart && !extractedTitle) {
          showToast("Hole Video-Titel für Pipeline...", "info", 3000);
          try {
            const infoRes = await fetch(
              `/api/ytdlp-info?url=${encodeURIComponent(inputValue)}`,
            );
            if (infoRes.ok) {
              const infoData = await infoRes.json();
              if (infoData.title && infoData.title !== "Unbekannt") {
                extractedTitle = infoData.title;
              }
            }
          } catch (e) {
            console.warn("Konnte Titel nicht vorab abrufen:", e);
          }
        }

        const keepOnlyFinal =
          document.getElementById("pl-run-keep-final")?.checked || false;

        try {
          const res = await fetch("/api/pipelines/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pipeline_id: pipelineId,
              input_file: inputValue,
              title: extractedTitle,
              keep_only_final_output: keepOnlyFinal,
            }),
          });
          if (!res.ok) {
            const err = await res.json();
            showToast(
              err.detail || "Pipeline konnte nicht gestartet werden.",
              "warn",
            );
            return;
          }
          showToast("Pipeline gestartet.", "success");
          if (isDownloadStart) document.getElementById("pl-run-url").value = "";
          loadJobs();
        } catch (e) {
          showToast("Fehler beim Starten der Pipeline.", "warn");
        }
      }

      function openPipelineEditor(pipelineId) {
        pipelineEditingId = pipelineId;
        const existing = pipelineId
          ? pipelinesCache.find((p) => p.id === pipelineId)
          : null;

        document.getElementById("pipeline-editor-title").textContent = existing
          ? "Pipeline bearbeiten"
          : "Neue Pipeline";
        document.getElementById("pl-edit-name").value = existing
          ? existing.name
          : "";
        document.getElementById("pl-edit-desc").value = existing
          ? existing.description || ""
          : "";

        if (existing) {
          pipelineEditorStages = JSON.parse(
            JSON.stringify(existing.stages),
          ).map((st) => {
            const def = STAGE_TYPES[st.job_type] || STAGE_TYPES.video;
            return {
              job_type: st.job_type,
              label: st.label || "",
              ui_settings: st.ui_settings
                ? { ...def.defaults, ...st.ui_settings }
                : { ...def.defaults },
            };
          });
        } else {
          pipelineEditorStages = [blankPipelineStage()];
        }
        renderPipelineStageRows();
        openModal("pipeline-editor-modal");
      }

      function blankPipelineStage(jobType) {
        jobType = jobType || "download";
        const def = STAGE_TYPES[jobType];
        return {
          job_type: jobType,
          label: "",
          ui_settings: { ...def.defaults },
        };
      }

      function addPipelineStageRow() {
        pipelineEditorStages.push(blankPipelineStage("audio"));
        renderPipelineStageRows();
      }

      function removePipelineStageRow(index) {
        if (pipelineEditorStages.length <= 1) {
          showToast("Eine Pipeline benötigt mindestens eine Stufe.", "warn");
          return;
        }
        pipelineEditorStages.splice(index, 1);
        renderPipelineStageRows();
      }

      function moveStage(index, direction) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= pipelineEditorStages.length) return;
        [pipelineEditorStages[index], pipelineEditorStages[newIndex]] = [
          pipelineEditorStages[newIndex],
          pipelineEditorStages[index],
        ];
        renderPipelineStageRows();
      }

      function updateStageType(index, newType) {
        const def = STAGE_TYPES[newType];
        pipelineEditorStages[index] = {
          job_type: newType,
          label: pipelineEditorStages[index].label || "",
          ui_settings: { ...def.defaults },
        };
        renderPipelineStageRows();
      }

      function updatePipelineStageField(index, field, value) {
        pipelineEditorStages[index][field] = value;
      }

      function updateStageSetting(index, key, value) {
        pipelineEditorStages[index].ui_settings[key] = value;
        renderPipelineStageRows();
      }

      function renderPipelineStageRows() {
        const container = document.getElementById("pl-edit-stages");
        container.innerHTML = pipelineEditorStages
          .map((stage, idx) => {
            const def = STAGE_TYPES[stage.job_type] || STAGE_TYPES.video;
            const settings = stage.ui_settings || { ...def.defaults };
            stage.ui_settings = settings;
            const availableTypes = Object.keys(STAGE_TYPES).filter(
              (t) => t !== "download" || idx === 0,
            );
            const built = def.build(settings);
            const previewCmd = `${built.tool} ${built.command_args.join(" ")}`;

            return `
                <div class="card" style="padding:0.8rem 0.9rem; border:1px solid var(--line);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.6rem; flex-wrap:wrap; gap:0.4rem;">
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <span class="status-badge" style="background:var(--surface-sunken); border:1px solid var(--line);">Stufe ${idx + 1}</span>
                            <span style="font-size:0.7rem; color:var(--ink-dim);">
                                ${
                                  idx === 0
                                    ? stage.job_type === "download"
                                      ? "Startet die Pipeline mit einer URL"
                                      : "Startet die Pipeline mit einer Eingabedatei"
                                    : `Eingabe = Ausgabe von Stufe ${idx}`
                                }
                            </span>
                        </div>
                        <div style="display:flex; gap:0.3rem;">
                            <button onclick="moveStage(${idx}, -1)" class="icon-btn" title="Nach oben" ${idx === 0 ? "disabled" : ""}>↑</button>
                            <button onclick="moveStage(${idx}, 1)" class="icon-btn" title="Nach unten" ${idx === pipelineEditorStages.length - 1 ? "disabled" : ""}>↓</button>
                            <button onclick="removePipelineStageRow(${idx})" class="icon-btn" title="Stufe entfernen">✕</button>
                        </div>
                    </div>
                    <div class="grid-2">
                        <div>
                            <label>Aktion:</label>
                            <select onchange="updateStageType(${idx}, this.value)">
                                ${availableTypes.map((t) => `<option value="${t}" ${stage.job_type === t ? "selected" : ""}>${STAGE_TYPES[t].label}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>Label (optional):</label>
                            <input type="text" value="${escapeHtml(stage.label || "")}"
                                   onchange="updatePipelineStageField(${idx}, 'label', this.value)"
                                   placeholder="z. B. Vorschau-Thumbnail">
                        </div>
                    </div>
                    <div style="margin-top:0.6rem;">
                        ${def.fields(settings, idx)}
                    </div>
                    <div class="code-box" style="margin-top:0.6rem; font-size:0.68rem; padding:0.5rem 0.6rem; overflow-x:auto; white-space:nowrap;">${escapeHtml(previewCmd)}</div>
                </div>`;
          })
          .join("");
      }

      async function savePipelineFromEditor() {
        const name = document.getElementById("pl-edit-name").value.trim();
        if (!name) {
          showToast("Bitte einen Namen für die Pipeline angeben.", "warn");
          return;
        }
        if (pipelineEditorStages.length === 0) {
          showToast("Mindestens eine Stufe wird benötigt.", "warn");
          return;
        }

        const stages = pipelineEditorStages.map((stage) => {
          const def = STAGE_TYPES[stage.job_type] || STAGE_TYPES.video;
          const built = def.build(stage.ui_settings);
          return {
            job_type: stage.job_type,
            tool: built.tool,
            label: stage.label || "",
            command_args: built.command_args,
            second_pass_args: built.second_pass_args,
            output_ext: built.output_ext,
            ui_settings: stage.ui_settings,
          };
        });

        const payload = {
          name,
          description: document.getElementById("pl-edit-desc").value.trim(),
          stages,
        };
        if (pipelineEditingId) payload.id = pipelineEditingId;

        try {
          const res = await fetch(
            pipelineEditingId
              ? `/api/pipelines/${pipelineEditingId}`
              : "/api/pipelines",
            {
              method: pipelineEditingId ? "PUT" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          if (!res.ok) {
            const err = await res.json();
            showToast(err.detail || "Speichern fehlgeschlagen.", "warn");
            return;
          }
          showToast("Pipeline gespeichert.", "success");
          closeModal("pipeline-editor-modal");
          refreshPipelines();
        } catch (e) {
          showToast("Fehler beim Speichern der Pipeline.", "warn");
        }
      }

      async function deletePipeline(pipelineId) {
        if (!confirm("Diese Pipeline wirklich löschen?")) return;
        try {
          const res = await fetch(`/api/pipelines/${pipelineId}`, {
            method: "DELETE",
          });
          if (!res.ok) {
            showToast("Löschen fehlgeschlagen.", "warn");
            return;
          }
          showToast("Pipeline gelöscht.", "success");
          refreshPipelines();
        } catch (e) {
          showToast("Fehler beim Löschen.", "warn");
        }
      }
