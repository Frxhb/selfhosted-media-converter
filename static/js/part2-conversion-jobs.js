function dismissToast(toast) {
        if (!toast || !toast.parentNode) return;
        clearTimeout(toast._timer);
        toast.classList.remove("visible");
        setTimeout(() => toast.remove(), 220);
      }

      async function copyCommandToClipboard(elId) {
        const el = document.getElementById(elId);
        if (!el) return;
        const text = el.textContent.trim();
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          showToast(t("toast.cmd_copied"), "success", 2200);
        } catch (e) {
          showToast(t("toast.copy_failed"), "warn");
        }
      }

      function switchMainGroup(groupId) {
        currentGroup = groupId;
        document
          .querySelectorAll(".group-view")
          .forEach((el) => el.classList.remove("active"));
        document
          .querySelectorAll(".stage-btn, .stage-btn-mobile")
          .forEach((btn) => btn.classList.remove("active"));

        document.getElementById(`group-${groupId}`).classList.add("active");
        document
          .querySelectorAll(`[data-group="${groupId}"]`)
          .forEach((btn) => btn.classList.add("active"));

        const importCard = document.getElementById("file-import-card");
        importCard.style.display =
          groupId === "converter" || groupId === "special" ? "block" : "none";

        if (groupId === "dashboard") fetchStats();
        if (groupId === "library") refreshOutputFiles();
        if (groupId === "pipelines") refreshPipelines();
        if (groupId === "subscriptions") refreshSubscriptions();
      }

      function switchSubTab(groupPrefix, subId) {
        if (groupPrefix === "conv") activeConvSubTab = subId;
        if (groupPrefix === "dl") activeDlSubTab = subId;

        refreshFiles(); // Dropdown-Filter aktualisieren

        document
          .querySelectorAll(`.subtab-${groupPrefix}-content`)
          .forEach((el) => el.classList.remove("active"));
        document
          .querySelectorAll(`.subtab-${groupPrefix}`)
          .forEach((btn) => btn.classList.remove("active"));

        document
          .getElementById(`subtab-${groupPrefix}-${subId}`)
          .classList.add("active");
        document
          .querySelectorAll(`.subtab-${groupPrefix}[data-sub="${subId}"]`)
          .forEach((btn) => btn.classList.add("active"));
        updateAllPreviews();
      }

      function updateDownloadQualityOptions() {
        const isAudio = document.getElementById("d-type").value === "audio";
        const resSelect = document.getElementById("d-res");
        const containerSelect = document.getElementById("d-container");

        if (isAudio) {
          resSelect.innerHTML = MediaOptions.audio.bitrates.map((q) => `<option value="${q.val}">${getOptionLabel(q.val, q.label)}</option>`).join("");
          containerSelect.innerHTML = MediaOptions.audio.formats.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join("");
        } else {
          resSelect.innerHTML = MediaOptions.video.resolutions.map((q) => `<option value="${q.val}">${getOptionLabel(q.val, q.label)}</option>`).join("");
          containerSelect.innerHTML = MediaOptions.video.downloadContainers.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join("");
        }
      }

      function updateYtdlpPreview() {
        let target = "URL_HIER";
        if (activeDlSubTab === "single") {
          target =
            sanitizeUrl(document.getElementById("d-url").value) || "URL_HIER";
        } else {
          const batchSel = document.getElementById("d-batch-select").value;
          target = batchSel ? `-a "${batchSel}"` : "-a [BATCH_URLS]";
        }

        const type = document.getElementById("d-type").value;
        const res = document.getElementById("d-res").value;
        const container = document.getElementById("d-container").value;
        const customFlags = document
          .getElementById("d-custom-flags")
          .value.trim();

        let args = ["yt-dlp", "--no-colors"];
        if (type === "audio") {
          args.push(`-x --audio-format ${container} --audio-quality ${res}`);
        } else {
          if (res !== "best")
            args.push(`-f "bestvideo[height<=${res}]+bestaudio/best"`);
          args.push(`--merge-output-format ${container}`);
        }

        const outputSubdir = type === "audio" ? "audio" : "videos";
        if (customFlags) args.push(customFlags);
        args.push(`-o "/media/outputs/${outputSubdir}/%(title)s.%(ext)s"`, target);
        document.getElementById("d-cmd-preview").textContent = args.join(" ");
      }

      function updateAllPreviews() {
        updateAudioPreview();
        updateVideoPreview();
        updateYtdlpPreview();
      }

      function updateAudioPreview() {
        const files = tabQueues["audio"];
        const input = files.length > 0 ? files[0].path : "INPUT_FILE";
        const fmt = document.getElementById("a-format").value;
        const bitrate = document.getElementById("a-bitrate").value;
        const customTitle = document
          .getElementById("a-custom-title")
          ?.value.trim();

        let outName = "output";
        if (customTitle) {
          outName = customTitle;
        } else if (files.length > 0) {
          outName = files[0].name.replace(/\.[^/.]+$/, "");
        }

        document.getElementById("a-cmd-preview").textContent =
          `ffmpeg -hide_banner -y -i "${input}" -b:a ${bitrate} "/media/outputs/audio/${outName}.${fmt}"`;
      }

      function updateVideoPreview() {
        const files = tabQueues["video"];
        const input = files.length > 0 ? files[0].path : "INPUT_FILE";
        const container = document.getElementById("v-container").value;
        const vcodec = document.getElementById("v-vcodec").value;
        const acodec = document.getElementById("v-acodec").value;
        const crf = document.getElementById("v-crf").value;
        const trimStart = document.getElementById("v-trim-start").value.trim();
        const trimEnd = document.getElementById("v-trim-end").value.trim();
        const customTitle = document
          .getElementById("v-custom-title")
          ?.value.trim();

        let outName = "output";
        if (customTitle) {
          outName = customTitle;
        } else if (files.length > 0) {
          outName = files[0].name.replace(/\.[^/.]+$/, "") + "_converted";
        }

        let args = [`ffmpeg -hide_banner -y`];
        if (trimStart) args.push(`-ss ${trimStart}`);
        args.push(`-i "${input}"`);
        if (trimEnd) args.push(`-to ${trimEnd}`);
        args.push(`-c:v ${vcodec}`);
        if (vcodec !== "copy") args.push(`-crf ${crf}`);
        args.push(`-c:a ${acodec}`, `"/media/outputs/videos/${outName}.${container}"`);
        document.getElementById("v-cmd-preview").textContent = args.join(" ");
      }

      async function checkIfAV1Codec(filePath) {
        try {
          if (!filePath) return false;
          const res = await fetch(
            `/api/media-info?file_path=${encodeURIComponent(filePath)}`,
          );
          if (!res.ok) return false;
          const info = await res.json();
          if (info && info.streams) {
            return info.streams.some(
              (s) => s.codec_name && s.codec_name.toLowerCase() === "av1",
            );
          }
        } catch (e) {}
        return false;
      }

      async function submitVideoJob() {
        const files = tabQueues["video"];
        if (files.length === 0)
          return showToast(t("toast.video_queue_empty"), "warn");

        if (useClientFFmpeg) {
          const fallbackServerFiles = [];
          for (const f of files) {
            const cJobId =
              "local_" + Math.random().toString(36).substring(2, 9);
            activeLocalJobId = cJobId;
            clientJobs[cJobId] = {
              id: cJobId,
              title: f.name,
              status: "running",
              progress: 0.0,
              eta: t("label.checking_codec"),
            };
            renderJobsCombined();

            try {
              const isAV1 = await checkIfAV1Codec(f.path);
              if (isAV1) {
                delete clientJobs[cJobId];
                fallbackServerFiles.push(f);
                continue;
              }
              if (!ffmpegWasm) await initFFmpegWasm();

              let fileSource = f.fileObj || f.path;
              if (
                typeof fileSource === "string" &&
                fileSource.startsWith("/media/")
              ) {
                const relName = fileSource.replace(
                  /\/media\/(inputs|outputs)\//,
                  "",
                );
                fileSource = `/api/files/inputs/download/${encodeURIComponent(relName)}`;
              }

              const res = await fetch(fileSource);
              const inputData = new Uint8Array(await res.arrayBuffer());
              await ffmpegWasm.writeFile(f.name, inputData);

              const container = document.getElementById("v-container").value;
              const vcodec = document.getElementById("v-vcodec").value;
              const acodec = document.getElementById("v-acodec").value;
              const crf = document.getElementById("v-crf").value;
              const outName = `converted_${f.name.replace(/\.[^/.]+$/, "")}.${container}`;

              let ffmpegArgs = ["-i", f.name];
              if (vcodec !== "copy")
                ffmpegArgs.push("-c:v", vcodec, "-crf", crf);
              else ffmpegArgs.push("-c:v", "copy");
              ffmpegArgs.push("-c:a", acodec, outName);

              await ffmpegWasm.exec(ffmpegArgs);
              const data = await ffmpegWasm.readFile(outName);

              const blob = new Blob([data.buffer], {
                type: `video/${container}`,
              });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = outName;
              a.click();

              clientJobs[cJobId].status = "completed";
              clientJobs[cJobId].progress = 100.0;
              renderJobsCombined();
            } catch (err) {
              if (clientJobs[cJobId]) clientJobs[cJobId].status = "failed";
              fallbackServerFiles.push(f);
            }
          }
          if (fallbackServerFiles.length > 0)
            submitServerVideoJobs(fallbackServerFiles);
          clearTabQueue("video");
          return;
        }

        submitServerVideoJobs(files);
        clearTabQueue("video");
      }

      async function submitServerVideoJobs(files) {
        const container = document.getElementById("v-container").value;
        const vcodec = document.getElementById("v-vcodec").value;
        const acodec = document.getElementById("v-acodec").value;
        const crf = document.getElementById("v-crf").value;
        const trimStart = document.getElementById("v-trim-start").value.trim();
        const trimEnd = document.getElementById("v-trim-end").value.trim();
        const customTitle = document
          .getElementById("v-custom-title")
          ?.value.trim();

        if (files.length > 1) {
          showToast(t("toast.starting_video_jobs").replace("{count}", files.length), "info", 2500);
        }

        for (let idx = 0; idx < files.length; idx++) {
          const f = files[idx];
          const baseName = f.name.replace(/\.[^/.]+$/, "");
          let outName = customTitle
            ? files.length > 1
              ? `${customTitle}_${idx + 1}`
              : customTitle
            : `${baseName}_converted`;
          const outPath = `/media/outputs/videos/${outName}.${container}`;

          let args = ["-hide_banner", "-y"];
          if (trimStart) args.push("-ss", trimStart);
          args.push("-i", f.path);
          if (trimEnd) args.push("-to", trimEnd);
          args.push("-c:v", vcodec);
          if (vcodec !== "copy") args.push("-crf", crf);
          args.push("-c:a", acodec, outPath);

          await submitJob({
            job_type: "video",
            tool: "ffmpeg",
            title: customTitle || f.name,
            command_args: args,
            input_file: f.path,
            output_file: outPath,
          });
          if ((idx + 1) % 3 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        clearTabQueue("video");
      }

      async function submitAudioJob() {
        const files = tabQueues["audio"];
        if (files.length === 0)
          return showToast(t("toast.audio_queue_empty"), "warn");

        const fmt = document.getElementById("a-format").value;
        const bitrate = document.getElementById("a-bitrate").value;
        const vol = document.getElementById("a-volume").value;
        const customTitle = document
          .getElementById("a-custom-title")
          ?.value.trim();

        if (files.length > 1) {
          showToast(t("toast.starting_audio_jobs").replace("{count}", files.length), "info", 2500);
        }

        for (let idx = 0; idx < files.length; idx++) {
          const f = files[idx];
          const baseName = f.name.replace(/\.[^/.]+$/, "");
          let outName = customTitle
            ? files.length > 1
              ? `${customTitle}_${idx + 1}`
              : customTitle
            : baseName;
          const outPath = `/media/outputs/audio/${outName}.${fmt}`;
          let args = ["-hide_banner", "-y", "-i", f.path, "-b:a", bitrate];

          if (vol === "boost_150") args.push("-filter:a", "volume=1.5");
          else if (vol === "boost_200") args.push("-filter:a", "volume=2.0");
          else if (vol === "ebur128")
            args.push("-filter:a", "loudnorm=I=-16:LRA=11:TP=-1.5");

          args.push(outPath);
          await submitJob({
            job_type: "audio",
            tool: "ffmpeg",
            title: customTitle || f.name,
            command_args: args,
            input_file: f.path,
            output_file: outPath,
          });
          if ((idx + 1) % 3 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }

        clearTabQueue("audio");
      }

      async function submitSpeedJob() {
        const queueFiles = tabQueues["tools"];
        let filesToProcess = [];

        if (queueFiles && queueFiles.length > 0) {
          filesToProcess = [...queueFiles];
        } else {
          const select = document.getElementById("global-file-select");
          const filePath = select.value;
          if (!filePath)
            return showToast(t("toast.select_file_import_manager"), "warn");
          const fileName = filePath.split("/").pop();
          filesToProcess.push({ name: fileName, path: filePath });
        }

        const speed = parseFloat(
          document.getElementById("tool-speed-val").value,
        );
        const setpts = (1.0 / speed).toFixed(2);
        const atempo = speed.toFixed(2);

        for (let idx = 0; idx < filesToProcess.length; idx++) {
          const f = filesToProcess[idx];
          const fileName = f.name || f.path.split("/").pop();
          const baseName = fileName.replace(/\.[^/.]+$/, "");
          const ext = fileName.split(".").pop().toLowerCase();
          const isAudio = ["mp3", "m4a", "flac", "wav", "ogg", "aac", "opus", "wma"].includes(ext);

          let outPath = "";
          let args = [];

          if (isAudio) {
            outPath = `/media/outputs/audio/${baseName}_${speed}x.${ext}`;
            args = [
              "-hide_banner",
              "-y",
              "-i",
              f.path,
              "-filter:a",
              `atempo=${atempo}`,
              outPath,
            ];
          } else {
            outPath = `/media/outputs/videos/${baseName}_${speed}x.mp4`;
            args = [
              "-hide_banner",
              "-y",
              "-i",
              f.path,
              "-filter_complex",
              `[0:v]setpts=${setpts}*PTS[v];[0:a]atempo=${atempo}[a]`,
              "-map",
              "[v]",
              "-map",
              "[a]",
              outPath,
            ];
          }

          await submitJob({
            job_type: "speed",
            tool: "ffmpeg",
            title: `Speed ${speed}x: ${fileName}`,
            command_args: args,
            input_file: f.path,
            output_file: outPath,
          });
        }

        if (queueFiles && queueFiles.length > 0) {
          clearTabQueue("tools");
        }
      }

      async function submitThumbnailJob() {
        const queueFiles = tabQueues["tools"];
        let filesToProcess = [];

        if (queueFiles && queueFiles.length > 0) {
          filesToProcess = [...queueFiles];
        } else {
          const select = document.getElementById("global-file-select");
          const filePath = select.value;
          if (!filePath)
            return showToast(t("toast.select_file_import_manager"), "warn");
          const fileName = filePath.split("/").pop();
          filesToProcess.push({ name: fileName, path: filePath });
        }

        const timeStr =
          document.getElementById("tool-thumb-time").value.trim() || "00:00:05";

        for (let idx = 0; idx < filesToProcess.length; idx++) {
          const f = filesToProcess[idx];
          const fileName = f.name || f.path.split("/").pop();
          const baseName = fileName.replace(/\.[^/.]+$/, "");
          const outPath = `/media/outputs/images/${baseName}_thumb.jpg`;

          const args = [
            "-hide_banner",
            "-y",
            "-ss",
            timeStr,
            "-i",
            f.path,
            "-vframes",
            "1",
            "-q:v",
            "2",
            outPath,
          ];

          await submitJob({
            job_type: "thumbnail",
            tool: "ffmpeg",
            title: `Thumb (${timeStr}): ${fileName}`,
            command_args: args,
            input_file: f.path,
            output_file: outPath,
          });
        }

        if (queueFiles && queueFiles.length > 0) {
          clearTabQueue("tools");
        }
      }

      function submitImageJob() {
        const files = tabQueues["images"];
        if (files.length === 0)
          return showToast(t("toast.image_queue_empty"), "warn");

        const fmt = document.getElementById("i-format").value;
        const res = document.getElementById("i-res").value;

        files.forEach((f) => {
          const baseName = f.name.replace(/\.[^/.]+$/, "");
          const outPath = `/media/outputs/images/${baseName}.${fmt}`;
          let args = ["-hide_banner", "-y", "-i", f.path];
          if (res !== "orig") args.push("-vf", `scale=${res}:-1`);
          args.push(outPath);

          submitJob({
            job_type: "image",
            tool: "ffmpeg",
            title: f.name,
            command_args: args,
            input_file: f.path,
            output_file: outPath,
          });
        });
        clearTabQueue("images");
      }
