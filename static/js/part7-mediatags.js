async function openTagsEditor(relPath) {
        currentTagsEditFile = relPath;
        document.getElementById("tags-editor-filename").textContent = relPath;
        document.getElementById("tags-edit-title").value = "";
        document.getElementById("tags-edit-artist").value = "";
        document.getElementById("tags-edit-album").value = "";
        document.getElementById("tags-edit-date").value = "";
        document.getElementById("tags-edit-genre").value = "";
        document.getElementById("tags-edit-comment").value = "";

        openModal("tags-editor-modal");

        try {
          const res = await fetch(
            `/api/media-tags?file_path=${encodeURIComponent(relPath)}`,
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(
              err.detail || t("toast.tags_load_failed"),
              "warn",
            );
            return;
          }
          const tags = await res.json();
          document.getElementById("tags-edit-title").value = tags.title || "";
          document.getElementById("tags-edit-artist").value = tags.artist || "";
          document.getElementById("tags-edit-album").value = tags.album || "";
          document.getElementById("tags-edit-date").value = tags.date || "";
          document.getElementById("tags-edit-genre").value = tags.genre || "";
          document.getElementById("tags-edit-comment").value =
            tags.comment || "";
        } catch (e) {
          showToast(t("toast.tags_load_failed"), "warn");
        }
      }

      async function saveMediaTags() {
        if (!currentTagsEditFile) return;
        const btn = document.getElementById("btn-save-tags");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t("label.saving");

        const payload = {
          file_path: currentTagsEditFile,
          title: document.getElementById("tags-edit-title").value,
          artist: document.getElementById("tags-edit-artist").value,
          album: document.getElementById("tags-edit-album").value,
          date: document.getElementById("tags-edit-date").value,
          genre: document.getElementById("tags-edit-genre").value,
          comment: document.getElementById("tags-edit-comment").value,
        };

        try {
          const res = await fetch("/api/media-tags", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
          }
          showToast(t("toast.metadata_saved"), "success");
          closeModal("tags-editor-modal");
          refreshOutputFiles();
        } catch (e) {
          showToast(t("toast.save_failed") + e.message, "warn", 7000);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      /* ---------- PIPELINES ---------- */
      const STAGE_TYPES = {
        download: {
          get label() { return t("pipeline_stage.stage_download"); },
          tool: "yt-dlp",
          defaults: {
            mode: "video",
            resolution: "1080",
            videoContainer: "mp4",
            audioContainer: "mp3",
            audioQuality: "192k",
            extraFlags: "",
          },
          describe: (s) =>
            s.mode === "audio"
              ? t("pipeline_stage.desc_audio_download").replace("{container}", s.audioContainer.toUpperCase())
              : t("pipeline_stage.desc_video_download").replace("{quality}", s.resolution === "best" ? t("pipeline_stage.best_quality") : s.resolution + "p").replace("{container}", s.videoContainer.toUpperCase()),
          build: (s) => {
            let args = ["--no-colors"];
            let ext;
            if (s.mode === "audio") {
              args.push(
                "-x",
                "--audio-format",
                s.audioContainer,
                "--audio-quality",
                s.audioQuality || "192k",
              );
              ext = "." + s.audioContainer;
            } else {
              if (s.resolution !== "best")
                args.push(
                  "-f",
                  `bestvideo[height<=${s.resolution}]+bestaudio/best`,
                );
              args.push("--merge-output-format", s.videoContainer);
              ext = "." + s.videoContainer;
            }
            if (s.extraFlags && s.extraFlags.trim())
              args.push(...tokenizeCliFlags(s.extraFlags.trim()));
            args.push("-o", "{output_noext}.%(ext)s", "{input}");
            return {
              tool: "yt-dlp",
              command_args: args,
              second_pass_args: null,
              output_ext: ext,
            };
          },
          fields: (s, idx) => `
                    <div class="grid-2">
                        <div>
                            <label>${t("pipeline_stage.mode_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'mode', this.value)">
                                <option value="video" ${s.mode === "video" ? "selected" : ""}>${t("pipeline_stage.mode_video")}</option>
                                <option value="audio" ${s.mode === "audio" ? "selected" : ""}>${t("pipeline_stage.mode_audio_only")}</option>
                            </select>
                        </div>
                        ${
                          s.mode === "video"
                            ? `
                        <div>
                            <label>${t("pipeline_stage.resolution_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'resolution', this.value)">
                                ${MediaOptions.video.resolutions.map((r) => `<option value="${r.val}" ${s.resolution === r.val ? "selected" : ""}>${getOptionLabel(r.val, r.label)}</option>`).join("")}
                            </select>
                        </div>`
                            : `
                        <div>
                            <label>${t("pipeline_stage.audio_quality_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'audioQuality', this.value)">
                                ${MediaOptions.audio.bitrates.map((q) => `<option value="${q.val}" ${s.audioQuality === q.val ? "selected" : ""}>${getOptionLabel(q.val, q.label)}</option>`).join("")}
                            </select>
                        </div>`
                        }
                    </div>
                    <div class="grid-2" style="margin-top:0.5rem;">
                        <div>
                            <label>Format:</label>
                            ${
                              s.mode === "video"
                                ? `
                            <select onchange="updateStageSetting(${idx}, 'videoContainer', this.value)">
                                ${MediaOptions.video.downloadContainers.map((c) => `<option value="${c}" ${s.videoContainer === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>`
                                : `
                            <select onchange="updateStageSetting(${idx}, 'audioContainer', this.value)">
                                ${MediaOptions.audio.formats.map((c) => `<option value="${c}" ${s.audioContainer === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>`
                            }
                        </div>
                        <div>
                            <label>${t("pipeline_stage.extra_ytdlp_flags_label")}</label>
                            <input type="text" value="${escapeHtml(s.extraFlags || "")}" onchange="updateStageSetting(${idx}, 'extraFlags', this.value)" placeholder="--embed-subs">
                        </div>
                    </div>
                `,
        },
        audio: {
          get label() { return t("pipeline_stage.stage_audio"); },
          tool: "ffmpeg",
          defaults: { format: "mp3", bitrate: "192k", volume: "none" },
          describe: (s) => `${s.format.toUpperCase()} · ${s.bitrate}`,
          build: (s) => {
            let args = [
              "-hide_banner",
              "-y",
              "-i",
              "{input}",
              "-b:a",
              s.bitrate,
            ];
            if (s.volume === "boost_150") args.push("-filter:a", "volume=1.5");
            else if (s.volume === "boost_200")
              args.push("-filter:a", "volume=2.0");
            else if (s.volume === "ebur128")
              args.push("-filter:a", "loudnorm=I=-16:LRA=11:TP=-1.5");
            args.push("{output}");
            return {
              tool: "ffmpeg",
              command_args: args,
              second_pass_args: null,
              output_ext: "." + s.format,
            };
          },
          fields: (s, idx) => `
                    <div class="grid-2">
                        <div>
                            <label>Format:</label>
                            <select onchange="updateStageSetting(${idx}, 'format', this.value)">
                                ${MediaOptions.audio.formats.map((f) => `<option value="${f}" ${s.format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.bitrate_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'bitrate', this.value)">
                                ${MediaOptions.audio.bitrates.map((b) => `<option value="${b.val}" ${s.bitrate === b.val ? "selected" : ""}>${getOptionLabel(b.val, b.label)}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                    <div style="margin-top:0.5rem;">
                        <label>${t("pipeline_stage.volume_label")}</label>
                        <select onchange="updateStageSetting(${idx}, 'volume', this.value)">
                            <option value="none" ${s.volume === "none" ? "selected" : ""}>${t("pipeline_stage.volume_unchanged")}</option>
                            <option value="boost_150" ${s.volume === "boost_150" ? "selected" : ""}>${t("pipeline_stage.volume_boost_150")}</option>
                            <option value="boost_200" ${s.volume === "boost_200" ? "selected" : ""}>${t("pipeline_stage.volume_boost_200")}</option>
                            <option value="ebur128" ${s.volume === "ebur128" ? "selected" : ""}>${t("pipeline_stage.volume_normalize")}</option>
                        </select>
                    </div>
                `,
        },
        video: {
          get label() { return t("pipeline_stage.stage_video"); },
          tool: "ffmpeg",
          defaults: {
            container: "mp4",
            vcodec: "libx264",
            crf: "23",
            acodec: "aac",
          },
          describe: (s) =>
            `${s.container.toUpperCase()} · ${s.vcodec} · CRF ${s.crf}`,
          build: (s) => {
            let args = [
              "-hide_banner",
              "-y",
              "-i",
              "{input}",
              "-c:v",
              s.vcodec,
            ];
            if (s.vcodec !== "copy") args.push("-crf", String(s.crf));
            args.push("-c:a", s.acodec, "{output}");
            return {
              tool: "ffmpeg",
              command_args: args,
              second_pass_args: null,
              output_ext: "." + s.container,
            };
          },
          fields: (s, idx) => `
                    <div class="grid-2">
                        <div>
                            <label>${t("pipeline_stage.container_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'container', this.value)">
                                ${MediaOptions.video.containers.map((c) => `<option value="${c}" ${s.container === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.video_codec_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'vcodec', this.value)">
                                ${MediaOptions.video.codecs.map((c) => `<option value="${c.val}" ${s.vcodec === c.val ? "selected" : ""}>${getOptionLabel(c.val, c.label)}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                    <div class="grid-2" style="margin-top:0.5rem;">
                        <div>
                            <label>${t("pipeline_stage.crf_label")}</label>
                            <input type="number" min="0" max="51" value="${s.crf}" onchange="updateStageSetting(${idx}, 'crf', this.value)" ${s.vcodec === "copy" ? "disabled" : ""}>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.audio_codec_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'acodec', this.value)">
                                ${["aac", "copy"].map((c) => `<option value="${c}" ${s.acodec === c ? "selected" : ""}>${c}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                `,
        },
        image: {
          get label() { return t("pipeline_stage.stage_image"); },
          tool: "ffmpeg",
          defaults: { format: "jpg", resolution: "orig" },
          describe: (s) =>
            `${s.format.toUpperCase()} · ${s.resolution === "orig" ? t("pipeline_stage.desc_image_original") : t("pipeline_stage.desc_image_width").replace("{width}", s.resolution)}`,
          build: (s) => {
            let args = ["-hide_banner", "-y", "-i", "{input}"];
            if (s.resolution !== "orig")
              args.push("-vf", `scale=${s.resolution}:-1`);
            args.push("{output}");
            return {
              tool: "ffmpeg",
              command_args: args,
              second_pass_args: null,
              output_ext: "." + s.format,
            };
          },
          fields: (s, idx) => `
                    <div class="grid-2">
                        <div>
                            <label>Format:</label>
                            <select onchange="updateStageSetting(${idx}, 'format', this.value)">
                                ${["jpg", "png", "webp", "gif", "bmp", "tiff"].map((f) => `<option value="${f}" ${s.format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.width_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'resolution', this.value)">
                                ${[
                                  ["orig", "Original"],
                                  ["3840", "3840px (4K)"],
                                  ["2560", "2560px"],
                                  ["1920", "1920px (FHD)"],
                                  ["1280", "1280px (HD)"],
                                  ["1080", "1080px"],
                                  ["720", "720px"],
                                  ["480", "480px"],
                                ]
                                  .map(
                                    ([v, l]) =>
                                      `<option value="${v}" ${s.resolution === v ? "selected" : ""}>${l}</option>`,
                                  )
                                  .join("")}
                            </select>
                        </div>
                    </div>
                `,
        },
        thumbnail: {
          get label() { return t("pipeline_stage.stage_thumbnail"); },
          tool: "ffmpeg",
          defaults: { timestamp: "00:00:05" },
          describe: (s) => t("pipeline_stage.desc_thumbnail_at").replace("{timestamp}", s.timestamp),
          build: (s) => {
            const args = [
              "-hide_banner",
              "-y",
              "-ss",
              s.timestamp || "00:00:05",
              "-i",
              "{input}",
              "-vframes",
              "1",
              "-q:v",
              "2",
              "{output}",
            ];
            return {
              tool: "ffmpeg",
              command_args: args,
              second_pass_args: null,
              output_ext: ".jpg",
            };
          },
          fields: (s, idx) => `
                    <div>
                        <label>${t("pipeline_stage.timestamp_label")}</label>
                        <input type="text" value="${escapeHtml(s.timestamp || "00:00:05")}" onchange="updateStageSetting(${idx}, 'timestamp', this.value)" placeholder="00:00:05">
                    </div>
                `,
        },
        speed: {
          get label() { return t("pipeline_stage.stage_speed"); },
          tool: "ffmpeg",
          defaults: { factor: "1.5" },
          describe: (s) => `${s.factor}x`,
          build: (s) => {
            const speed = parseFloat(s.factor) || 1.0;
            const setpts = (1.0 / speed).toFixed(2);
            const atempo = speed.toFixed(2);
            const args = [
              "-hide_banner",
              "-y",
              "-i",
              "{input}",
              "-filter_complex",
              `[0:v]setpts=${setpts}*PTS[v];[0:a]atempo=${atempo}[a]`,
              "-map",
              "[v]",
              "-map",
              "[a]",
              "{output}",
            ];
            return {
              tool: "ffmpeg",
              command_args: args,
              second_pass_args: null,
              output_ext: ".mp4",
            };
          },
          fields: (s, idx) => `
                    <div>
                        <label>${t("pipeline_stage.factor_label")}</label>
                        <input type="number" step="0.1" min="0.25" max="4" value="${s.factor}" onchange="updateStageSetting(${idx}, 'factor', this.value)">
                    </div>
                `,
        },
        whisper: {
          get label() { return t("pipeline_stage.stage_whisper"); },
          tool: "whisper",
          defaults: {
            model: "base",
            format: "srt",
            language: "",
            customLanguage: "",
          },
          describe: (s) => {
            const lang =
              s.language === "custom" ? s.customLanguage : s.language;
            return `${s.model} · ${s.format.toUpperCase()}${lang ? ` · ${lang}` : ""}`;
          },
          build: (s) => {
            const args = [
              "--model",
              s.model,
              "--output_format",
              s.format,
              "--output_dir",
              "/media/outputs",
              "--verbose",
              "True",
            ];
            const lang =
              s.language === "custom"
                ? (s.customLanguage || "").trim()
                : (s.language || "").trim();
            if (lang) {
              args.push("--language", lang);
            }
            args.push("{input}");
            return {
              tool: "whisper",
              command_args: args,
              second_pass_args: null,
              output_ext: "." + s.format,
            };
          },
          fields: (s, idx) => `
                    <div class="grid-3">
                        <div>
                            <label>${t("pipeline_stage.model_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'model', this.value)">
                                ${["tiny", "base", "turbo", "small", "medium", "large-v3"].map((m) => `<option value="${m}" ${s.model === m ? "selected" : ""}>${m}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.output_format_label")}</label>
                            <select onchange="updateStageSetting(${idx}, 'format', this.value)">
                                ${["srt", "vtt", "txt", "json"].map((f) => `<option value="${f}" ${s.format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>${t("pipeline_stage.language_label")}</label>
                            <div style="display:flex; gap:0.4rem;">
                                <select onchange="updateStageSetting(${idx}, 'language', this.value)">
                                    <option value="" ${!s.language ? "selected" : ""}>${t("pipeline_stage.lang_auto")}</option>
                                    <option value="de" ${s.language === "de" ? "selected" : ""}>${t("pipeline_stage.lang_de")}</option>
                                    <option value="en" ${s.language === "en" ? "selected" : ""}>${t("pipeline_stage.lang_en")}</option>
                                    <option value="es" ${s.language === "es" ? "selected" : ""}>${t("pipeline_stage.lang_es")}</option>
                                    <option value="fr" ${s.language === "fr" ? "selected" : ""}>${t("pipeline_stage.lang_fr")}</option>
                                    <option value="it" ${s.language === "it" ? "selected" : ""}>${t("pipeline_stage.lang_it")}</option>
                                    <option value="custom" ${s.language === "custom" ? "selected" : ""}>${t("pipeline_stage.lang_manual")}</option>
                                </select>
                                ${
                                  s.language === "custom"
                                    ? `
                                <input type="text" value="${escapeHtml(s.customLanguage || "")}"
                                       placeholder="${t('pipeline_stage.lang_manual_placeholder')}"
                                       onfocus="if(!this.dataset.ph) this.dataset.ph=this.placeholder; this.placeholder=''"
                                       onblur="if(this.dataset.ph) this.placeholder=this.dataset.ph"
                                       onchange="updateStageSetting(${idx}, 'customLanguage', this.value)"
                                       style="width:110px;">
                                `
                                    : ""
                                }
                            </div>
                        </div>
                    </div>
                `,
        },
      };
