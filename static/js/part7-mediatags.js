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
              err.detail || "Tags konnten nicht geladen werden.",
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
          showToast("Tags konnten nicht geladen werden.", "warn");
        }
      }

      async function saveMediaTags() {
        if (!currentTagsEditFile) return;
        const btn = document.getElementById("btn-save-tags");
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Speichere...";

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
          showToast("Metadaten gespeichert.", "success");
          closeModal("tags-editor-modal");
          refreshOutputFiles();
        } catch (e) {
          showToast("Speichern fehlgeschlagen: " + e.message, "warn", 7000);
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      }

      /* ---------- PIPELINES ---------- */
      const STAGE_TYPES = {
        download: {
          label: "⬇️ Download",
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
              ? `Audio-Download (${s.audioContainer.toUpperCase()})`
              : `Video-Download (${s.resolution === "best" ? "beste Qualität" : s.resolution + "p"}, ${s.videoContainer.toUpperCase()})`,
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
              args.push(
                ...s.extraFlags
                  .trim()
                  .split(" ")
                  .filter((x) => x),
              );
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
                            <label>Modus:</label>
                            <select onchange="updateStageSetting(${idx}, 'mode', this.value)">
                                <option value="video" ${s.mode === "video" ? "selected" : ""}>Video</option>
                                <option value="audio" ${s.mode === "audio" ? "selected" : ""}>Nur Audio</option>
                            </select>
                        </div>
                        ${
                          s.mode === "video"
                            ? `
                        <div>
                            <label>Auflösung:</label>
                            <select onchange="updateStageSetting(${idx}, 'resolution', this.value)">
                                ${MediaOptions.video.resolutions.map((r) => `<option value="${r.val}" ${s.resolution === r.val ? "selected" : ""}>${r.label}</option>`).join("")}
                            </select>
                        </div>`
                            : `
                        <div>
                            <label>Audio-Qualität:</label>
                            <select onchange="updateStageSetting(${idx}, 'audioQuality', this.value)">
                                ${MediaOptions.audio.bitrates.map((q) => `<option value="${q.val}" ${s.audioQuality === q.val ? "selected" : ""}>${q.label}</option>`).join("")}
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
                                ${MediaOptions.video.containers.map((c) => `<option value="${c}" ${s.videoContainer === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>`
                                : `
                            <select onchange="updateStageSetting(${idx}, 'audioContainer', this.value)">
                                ${MediaOptions.audio.formats.map((c) => `<option value="${c}" ${s.audioContainer === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>`
                            }
                        </div>
                        <div>
                            <label>Extra yt-dlp Flags (optional):</label>
                            <input type="text" value="${escapeHtml(s.extraFlags || "")}" onchange="updateStageSetting(${idx}, 'extraFlags', this.value)" placeholder="--embed-subs">
                        </div>
                    </div>
                `,
        },
        audio: {
          label: "🎧 Audio extrahieren/konvertieren",
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
                            <label>Bitrate:</label>
                            <select onchange="updateStageSetting(${idx}, 'bitrate', this.value)">
                                ${MediaOptions.audio.bitrates.map((b) => `<option value="${b.val}" ${s.bitrate === b.val ? "selected" : ""}>${b.label}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                    <div style="margin-top:0.5rem;">
                        <label>Lautstärke:</label>
                        <select onchange="updateStageSetting(${idx}, 'volume', this.value)">
                            <option value="none" ${s.volume === "none" ? "selected" : ""}>Unverändert</option>
                            <option value="boost_150" ${s.volume === "boost_150" ? "selected" : ""}>+50% lauter</option>
                            <option value="boost_200" ${s.volume === "boost_200" ? "selected" : ""}>+100% lauter</option>
                            <option value="ebur128" ${s.volume === "ebur128" ? "selected" : ""}>Normalisieren (EBU R128)</option>
                        </select>
                    </div>
                `,
        },
        video: {
          label: "🎞️ Video konvertieren",
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
                            <label>Container:</label>
                            <select onchange="updateStageSetting(${idx}, 'container', this.value)">
                                ${MediaOptions.video.containers.map((c) => `<option value="${c}" ${s.container === c ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>Video-Codec:</label>
                            <select onchange="updateStageSetting(${idx}, 'vcodec', this.value)">
                                ${MediaOptions.video.codecs.map((c) => `<option value="${c.val}" ${s.vcodec === c.val ? "selected" : ""}>${c.label}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                    <div class="grid-2" style="margin-top:0.5rem;">
                        <div>
                            <label>CRF (Qualität, niedriger = besser):</label>
                            <input type="number" min="0" max="51" value="${s.crf}" onchange="updateStageSetting(${idx}, 'crf', this.value)" ${s.vcodec === "copy" ? "disabled" : ""}>
                        </div>
                        <div>
                            <label>Audio-Codec:</label>
                            <select onchange="updateStageSetting(${idx}, 'acodec', this.value)">
                                ${["aac", "copy"].map((c) => `<option value="${c}" ${s.acodec === c ? "selected" : ""}>${c}</option>`).join("")}
                            </select>
                        </div>
                    </div>
                `,
        },
        image: {
          label: "🖼️ Bild konvertieren",
          tool: "ffmpeg",
          defaults: { format: "jpg", resolution: "orig" },
          describe: (s) =>
            `${s.format.toUpperCase()} · ${s.resolution === "orig" ? "Originalgröße" : s.resolution + "px breit"}`,
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
                            <label>Breite:</label>
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
          label: "📸 Thumbnail extrahieren",
          tool: "ffmpeg",
          defaults: { timestamp: "00:00:05" },
          describe: (s) => `bei ${s.timestamp}`,
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
                        <label>Zeitpunkt (HH:MM:SS):</label>
                        <input type="text" value="${escapeHtml(s.timestamp || "00:00:05")}" onchange="updateStageSetting(${idx}, 'timestamp', this.value)" placeholder="00:00:05">
                    </div>
                `,
        },
        speed: {
          label: "⏩ Geschwindigkeit ändern",
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
                        <label>Faktor (z. B. 1.5 = 50% schneller):</label>
                        <input type="number" step="0.1" min="0.25" max="4" value="${s.factor}" onchange="updateStageSetting(${idx}, 'factor', this.value)">
                    </div>
                `,
        },
        whisper: {
          label: "📝 Transkribieren (Whisper)",
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
                            <label>Modell:</label>
                            <select onchange="updateStageSetting(${idx}, 'model', this.value)">
                                ${["tiny", "base", "turbo", "small", "medium", "large-v3"].map((m) => `<option value="${m}" ${s.model === m ? "selected" : ""}>${m}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>Ausgabeformat:</label>
                            <select onchange="updateStageSetting(${idx}, 'format', this.value)">
                                ${["srt", "vtt", "txt", "json"].map((f) => `<option value="${f}" ${s.format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
                            </select>
                        </div>
                        <div>
                            <label>Sprache (--language):</label>
                            <div style="display:flex; gap:0.4rem;">
                                <select onchange="updateStageSetting(${idx}, 'language', this.value)">
                                    <option value="" ${!s.language ? "selected" : ""}>Auto (Automatisch)</option>
                                    <option value="de" ${s.language === "de" ? "selected" : ""}>Deutsch (de)</option>
                                    <option value="en" ${s.language === "en" ? "selected" : ""}>Englisch (en)</option>
                                    <option value="es" ${s.language === "es" ? "selected" : ""}>Spanisch (es)</option>
                                    <option value="fr" ${s.language === "fr" ? "selected" : ""}>Französisch (fr)</option>
                                    <option value="it" ${s.language === "it" ? "selected" : ""}>Italienisch (it)</option>
                                    <option value="custom" ${s.language === "custom" ? "selected" : ""}>Manuell...</option>
                                </select>
                                ${
                                  s.language === "custom"
                                    ? `
                                <input type="text" value="${escapeHtml(s.customLanguage || "")}"
                                       placeholder="z. B. de, en, it"
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
