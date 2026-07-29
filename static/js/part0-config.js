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

// Automatische Initialisierung der statischen HTML-Selects (Converter Tab)
document.addEventListener('DOMContentLoaded', () => {
    const vContainer = document.getElementById('v-container');
    if(vContainer) vContainer.innerHTML = MediaOptions.video.containers.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('');

    const vCodec = document.getElementById('v-vcodec');
    if(vCodec) vCodec.innerHTML = MediaOptions.video.codecs.map(c => `<option value="${c.val}">${c.label}</option>`).join('');

    const vCrf = document.getElementById('v-crf');
    if(vCrf) vCrf.innerHTML = MediaOptions.video.crf.map(c => `<option value="${c.val}" ${c.default ? 'selected' : ''}>${c.label}</option>`).join('');

    const aFormat = document.getElementById('a-format');
    if(aFormat) aFormat.innerHTML = MediaOptions.audio.formats.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('');

    const aBitrate = document.getElementById('a-bitrate');
    if(aBitrate) aBitrate.innerHTML = MediaOptions.audio.bitrates.map(c => `<option value="${c.val}" ${c.default ? 'selected' : ''}>${c.label}</option>`).join('');
});
