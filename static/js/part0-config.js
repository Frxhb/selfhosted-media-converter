// static/js/part0-config.js

const MediaOptions = {
    video: {
        resolutions: [
            { val: "best", label: "Beste Qualität (Max/4K)" },
            { val: "2160", label: "2160p (4K UHD)" },
            { val: "1440", label: "1440p (QHD)" },
            { val: "1080", label: "1080p (FHD)" },
            { val: "720", label: "720p (HD)" },
            { val: "480", label: "480p (SD)" }
        ],
        containers: ["mp4", "mkv", "webm", "gif"],
        // yt-dlp's --merge-output-format only accepts avi/flv/mkv/mov/mp4/webm (no gif) -
        // separate list so the Downloader tab never offers an invalid combination.
        downloadContainers: ["mp4", "mkv", "webm"],
        codecs: [
            { val: "libx264", label: "H.264 (AVC)" },
            { val: "libx265", label: "H.265 (HEVC)" },
            { val: "libsvtav1", label: "AV1" },
            { val: "libvpx-vp9", label: "VP9" },
            { val: "copy", label: "Copy Video (Stream Copy)" }
        ],
        crf: [
            { val: "15", label: "15 (Sehr hoch)" },
            { val: "18", label: "18 (Visuell verlustfrei)" },
            { val: "23", label: "23 (Standard)", default: true },
            { val: "28", label: "28 (Kleinere Datei)" },
            { val: "32", label: "32 (Sehr klein)" }
        ]
    },
    audio: {
        bitrates: [ // Einheitliche Liste für yt-dlp (Downloads) UND ffmpeg (Converter)
            { val: "320k", label: "320 kbps (High Quality)" },
            { val: "256k", label: "256 kbps" },
            { val: "192k", label: "192 kbps (Standard)", default: true },
            { val: "128k", label: "128 kbps" },
            { val: "96k",  label: "96 kbps (Kleinere Datei)" },
            { val: "64k",  label: "64 kbps (Voice/Sprache)" }
        ],
        formats: ["mp3", "m4a", "flac", "wav", "opus", "ogg"]
    }
};

function getOptionLabel(val, defaultLabel) {
    if (typeof t !== 'function') return defaultLabel;
    if (val === "best") return t("options.best_quality", defaultLabel);
    if (val === "copy") return t("options.copy_stream", defaultLabel);
    if (val === "15") return t("options.crf_15", defaultLabel);
    if (val === "18") return t("options.crf_18", defaultLabel);
    if (val === "23") return t("options.crf_23", defaultLabel);
    if (val === "28") return t("options.crf_28", defaultLabel);
    if (val === "32") return t("options.crf_32", defaultLabel);
    if (val === "320k") return t("options.br_320", defaultLabel);
    if (val === "192k") return t("options.br_192", defaultLabel);
    if (val === "96k") return t("options.br_96", defaultLabel);
    if (val === "64k") return t("options.br_64", defaultLabel);
    return defaultLabel;
}

// Automatische Initialisierung der statischen HTML-Selects (Converter Tab)
function initConverterSelects() {
    const ids = ['v-container', 'v-vcodec', 'v-crf', 'a-format', 'a-bitrate'];
    const previous = Object.fromEntries(ids.map(id => [id, document.getElementById(id)?.value]));
    const vContainer = document.getElementById('v-container');
    if(vContainer) vContainer.innerHTML = MediaOptions.video.containers.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('');

    refreshVideoCodecOptions();

    const vCrf = document.getElementById('v-crf');
    if(vCrf) vCrf.innerHTML = MediaOptions.video.crf.map(c => `<option value="${c.val}" ${c.default ? 'selected' : ''}>${getOptionLabel(c.val, c.label)}</option>`).join('');

    const aFormat = document.getElementById('a-format');
    if(aFormat) aFormat.innerHTML = MediaOptions.audio.formats.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('');

    const aBitrate = document.getElementById('a-bitrate');
    if(aBitrate) aBitrate.innerHTML = MediaOptions.audio.bitrates.map(c => `<option value="${c.val}" ${c.default ? 'selected' : ''}>${getOptionLabel(c.val, c.label)}</option>`).join('');
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el && previous[id] && [...el.options].some(o => o.value === previous[id])) el.value = previous[id];
    }
    refreshVideoCodecOptions();
}

document.addEventListener('DOMContentLoaded', initConverterSelects);
window.addEventListener('mcp_i18n_changed', initConverterSelects);


let serverHardware = null;

function refreshVideoCodecOptions() {
    const select = document.getElementById('v-vcodec');
    const container = document.getElementById('v-container')?.value || 'mp4';
    if (!select) return;
    const previous = select.value;
    let codecs = MediaOptions.video.codecs.map(c => ({id: c.val, label: getOptionLabel(c.val, c.label)}));
    if (serverHardware?.available && !useClientFFmpeg) {
        codecs = [...serverHardware.encoders, {id: 'copy', label: getOptionLabel('copy', 'Stream Copy')}];
    }
    codecs = codecs.filter(c => container === 'gif' ? c.id === 'gif' : c.id !== 'gif');
    if (container === 'gif' && !codecs.length) codecs = [{id: 'gif', label: 'GIF'}];
    if (container === 'webm') codecs = codecs.filter(c => /av1|vp9|^copy$/.test(c.id));
    select.replaceChildren(...codecs.map(c => new Option(c.label, c.id)));
    if (codecs.some(c => c.id === previous)) select.value = previous;
    refreshVideoAudioOptions();
}

function refreshVideoAudioOptions() {
    const container = document.getElementById('v-container')?.value;
    const select = document.getElementById('v-acodec');
    if (!select) return;
    const previous = select.value;
    const codecs = container === 'gif' ? [] : container === 'webm'
        ? [['libopus', 'Opus'], ['libvorbis', 'Vorbis'], ['copy', 'Copy Audio']]
        : [['aac', 'AAC'], ['ac3', 'AC3'], ['copy', 'Copy Audio']];
    select.replaceChildren(...codecs.map(([value, label]) => new Option(label, value)));
    if (codecs.some(([value]) => value === previous)) select.value = previous;
    select.disabled = container === 'gif';
    const codec = document.getElementById('v-vcodec')?.value;
    document.getElementById('v-crf').disabled = codec === 'copy' || codec === 'gif';
}

function videoEncodingArgs(codec, quality, container, audioCodec) {
    const profile = serverHardware?.encoders.find(c => c.id === codec);
    const args = ['-c:v', codec];
    if (codec !== 'copy' && codec !== 'gif') {
        const flag = profile?.quality || 'crf';
        // VideoToolbox uses a 1–100 scale with higher values meaning better quality.
        args.push('-' + flag, flag === 'q:v' ? String(Math.round(100 - Number(quality) * 1.5)) : String(quality));
        if (flag === 'cq' || codec === 'libvpx-vp9') args.push('-b:v', '0');
        if (!profile?.hardware) args.push('-pix_fmt', 'yuv420p');
    }
    if (profile?.filter_args?.length) args.push(...profile.filter_args);
    if (container === 'gif') args.push('-an');
    else args.push('-c:a', audioCodec);
    if (container === 'mp4') args.push('-movflags', '+faststart');
    return args;
}

async function loadHardwareInfo() {
    const el = document.getElementById('hardware-summary');
    try {
        const response = await fetch('/api/system/hardware');
        if (!response.ok) throw new Error(response.status);
        serverHardware = await response.json();
        if (el) el.textContent = serverHardware.available
            ? `${serverHardware.platform} / ${serverHardware.architecture} · CPU: ${serverHardware.cpu_budget} · RAM: ${serverHardware.memory_gb} GB · Auto: ${serverHardware.auto_threads_per_job} ${t('hardware.threads', 'Threads/Job')} · GPU: ${serverHardware.encoders.filter(c => c.hardware).map(c => c.label).join(', ') || t('hardware.no_gpu', 'kein nutzbarer Encoder')}`
            : t('hardware.no_ffmpeg', 'FFmpeg ist nicht verfügbar.');
        refreshVideoCodecOptions();
        updateVideoPreview();
    } catch (error) {
        if (el) el.textContent = t('hardware.failed', 'Hardware-Diagnose fehlgeschlagen.');
    }
}

document.addEventListener('DOMContentLoaded', loadHardwareInfo);
window.addEventListener('mcp_i18n_changed', loadHardwareInfo);
