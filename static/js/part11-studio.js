/* Task-based entry points and reusable video profiles. No extra runtime dependency. */
const studioProfiles = {
  universal: {container: 'mp4', codecs: ['libx264'], crf: '23', resolution: '1080'},
  compact: {container: 'mp4', codecs: ['libx265', 'libx264'], crf: '28', resolution: '720'},
  web: {container: 'webm', codecs: ['libvpx-vp9', 'libsvtav1'], crf: '28', resolution: '1080'},
  remux: {container: 'mkv', codecs: ['copy'], crf: '23', resolution: 'source'},
};
let studioSelectedProfile = '';
let studioSubmitting = false;
const studioProfileKey = 'mcp_video_profile_v1';
const studioValue = (id, fallback = '') => document.getElementById(id)?.value || fallback;

function studioNavigate(group, sub) {
  switchMainGroup(group);
  if (sub) switchSubTab('conv', sub);
  document.getElementById(group === 'converter' ? 'file-import-card' : `group-${group}`)?.scrollIntoView({behavior: 'auto', block: 'start'});
}

function renderStudioProfiles() {
  const host = document.getElementById('studio-profiles');
  if (!host) return;
  host.setAttribute('aria-label', t('studio.profile_title'));
  host.replaceChildren(...Object.keys(studioProfiles).map(id => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'studio-profile';
    button.setAttribute('aria-pressed', String(studioSelectedProfile === id));
    const title = document.createElement('strong');
    title.textContent = t(`studio.profiles.${id}.title`);
    const description = document.createElement('small');
    description.textContent = t(`studio.profiles.${id}.description`);
    button.append(title, description);
    button.addEventListener('click', () => applyStudioProfile(id));
    return button;
  }));
  try { document.getElementById('studio-restore-profile').hidden = !localStorage.getItem(studioProfileKey); } catch (_) {}
}

function applyStudioProfile(id) {
  const profile = studioProfiles[id];
  if (!profile) return;
  document.getElementById('v-container').value = profile.container;
  refreshVideoCodecOptions();
  const codec = document.getElementById('v-vcodec');
  const available = [...codec.options].map(o => o.value);
  const choice = profile.codecs.find(c => available.includes(c));
  if (!choice) {
    studioSelectedProfile = '';
    showToast(t('studio.codec_unavailable'), 'warn');
    updateVideoPreview();
    return;
  }
  codec.value = choice;
  document.getElementById('v-crf').value = profile.crf;
  refreshVideoAudioOptions();
  document.getElementById('v-acodec').value = id === 'remux' ? 'copy' : id === 'web' ? 'libopus' : 'aac';
  document.getElementById('studio-resolution').value = profile.resolution;
  document.getElementById('studio-fps').value = 'source';
  document.getElementById('studio-mute').checked = false;
  studioSelectedProfile = id;
  renderStudioProfiles();
  updateVideoPreview();
}

function studioReadVideoSettings() {
  return {
    container: studioValue('v-container', 'mp4'), codec: studioValue('v-vcodec'),
    audio: studioValue('v-acodec', 'aac'), quality: studioValue('v-crf', '23'),
    resolution: studioValue('studio-resolution', 'source'), fps: studioValue('studio-fps', 'source'),
    mute: !!document.getElementById('studio-mute')?.checked,
    start: studioValue('v-trim-start').trim(), end: studioValue('v-trim-end').trim(),
  };
}

function studioTimeSeconds(value) {
  if (!value) return 0;
  if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d+)?$/.test(value)) return NaN;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function studioValidate(settings) {
  if (!settings.codec) return t('studio.codec_unavailable');
  if (settings.codec === 'copy' && (settings.resolution !== 'source' || settings.fps !== 'source'))
    return t('studio.copy_conflict');
  const start = studioTimeSeconds(settings.start), end = studioTimeSeconds(settings.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || (settings.end && end <= start))
    return t('studio.trim_invalid');
  if (/[\\/:*?"<>|\x00-\x1f]/.test(studioValue('v-custom-title')))
    return t('studio.name_invalid');
  return '';
}

function buildStudioVideoCommand(input, output, settings = studioReadVideoSettings()) {
  const profile = typeof serverHardware !== 'undefined' ? serverHardware?.encoders.find(c => c.id === settings.codec) : null;
  const args = ['-hide_banner', '-y', ...(profile?.input_args || [])];
  if (settings.start) args.push('-ss', settings.start);
  args.push('-i', input);
  if (settings.end) args.push('-t', String(studioTimeSeconds(settings.end) - studioTimeSeconds(settings.start)));
  const encoding = videoEncodingArgs(settings.codec, settings.quality, settings.container, settings.audio);
  const filters = [];
  if (settings.resolution !== 'source') {
    // Fit within a box, preserve aspect ratio, never upscale, keep even dimensions.
    const height = Number(settings.resolution), width = Math.round(height * 16 / 9);
    filters.push(`scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  if (settings.fps !== 'source') filters.push(`fps=${settings.fps}`);
  if (filters.length) {
    const vf = encoding.indexOf('-vf');
    if (vf >= 0) encoding[vf + 1] = [...filters, encoding[vf + 1]].join(',');
    else encoding.push('-vf', filters.join(','));
  }
  if (settings.mute && settings.container !== 'gif') {
    const audio = encoding.indexOf('-c:a');
    if (audio >= 0) encoding.splice(audio, 2);
    encoding.push('-an');
  }
  return [...args, ...encoding, output];
}

function updateStudioSummary() {
  const summary = document.getElementById('studio-summary');
  if (!summary) return;
  const settings = studioReadVideoSettings();
  const count = tabQueues.video.length;
  const codec = document.getElementById('v-vcodec');
  summary.textContent = `${count} ${t('studio.files')} → ${settings.container.toUpperCase()} · ${codec.options[codec.selectedIndex]?.textContent || settings.codec}\n${settings.resolution === 'source' ? t('studio.original') : '≤ ' + settings.resolution + 'p'} · ${settings.fps === 'source' ? t('studio.original_fps') : settings.fps + ' fps'} · ${settings.mute || settings.container === 'gif' ? t('studio.no_audio') : settings.audio.toUpperCase()}`;
  if (settings.start || settings.end) summary.textContent += `\n${t('studio.trim')}: ${settings.start || '00:00:00'} → ${settings.end || t('studio.until_end')}`;
  const error = studioValidate(settings);
  document.getElementById('studio-validation').textContent = error || (!count ? t('studio.add_first') : '');
  const startButton = document.getElementById('studio-start-video');
  startButton.disabled = !count || !!error || studioSubmitting;
  startButton.textContent = studioSubmitting ? t('studio.starting') : count === 1 ? t('studio.start_one') : count > 1 ? t('studio.start_many').replace('{count}', count) : t('studio.start_empty');
  const note = document.getElementById('studio-profile-note');
  note.textContent = studioSelectedProfile ? t(`studio.profiles.${studioSelectedProfile}.note`) : t('studio.custom_note');
  document.querySelectorAll('.studio-profile').forEach((button, index) => button.setAttribute('aria-pressed', String(Object.keys(studioProfiles)[index] === studioSelectedProfile)));
}

function studioSettingChanged() {
  studioSelectedProfile = '';
  updateVideoPreview();
}

function saveStudioProfile() {
  const settings = studioReadVideoSettings();
  const error = studioValidate(settings);
  if (error) return showToast(error, 'warn');
  try {
    // Source paths, output names and trim ranges are deliberately not saved.
    const {start, end, ...profile} = settings;
    localStorage.setItem(studioProfileKey, JSON.stringify({version: 1, ...profile}));
    renderStudioProfiles();
    showToast(t('studio.saved'), 'success');
  } catch (_) { showToast(t('studio.storage_failed'), 'warn'); }
}

function restoreStudioProfile() {
  try {
    const data = JSON.parse(localStorage.getItem(studioProfileKey));
    if (!data || data.version !== 1) throw new Error('profile');
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (![...el.options].some(o => o.value === value)) throw new Error('option');
      el.value = value;
    };
    set('v-container', data.container);
    refreshVideoCodecOptions();
    set('v-vcodec', data.codec);
    refreshVideoAudioOptions();
    if (data.container !== 'gif') set('v-acodec', data.audio);
    set('v-crf', data.quality);
    set('studio-resolution', data.resolution);
    set('studio-fps', data.fps);
    document.getElementById('studio-mute').checked = data.mute === true;
    studioSelectedProfile = '';
    updateVideoPreview();
    showToast(t('studio.restored'), 'success');
  } catch (_) {
    updateVideoPreview();
    showToast(t('studio.restore_failed'), 'warn');
  }
}

function updateStudioWorkspace() {
  const heading = document.getElementById('studio-workspace-heading');
  if (!heading) return;
  const key = currentGroup === 'converter' ? 'convert' : currentGroup === 'special' ? 'ai' : '';
  heading.hidden = !key;
  if (key) {
    document.getElementById('studio-workspace-title').textContent = t('studio.' + key);
    document.getElementById('studio-workspace-description').textContent = t('studio.' + key + '_intro');
  }
}

function initStudio() {
  renderStudioProfiles();
  updateStudioWorkspace();
  applyStudioProfile('universal');
  const host = document.getElementById('subtab-conv-video');
  host.addEventListener('change', event => {
    if (event.target.matches('select, input')) studioSettingChanged();
  });
  host.addEventListener('input', event => {
    if (event.target.matches('input')) updateStudioSummary();
  });
}
document.addEventListener('DOMContentLoaded', initStudio);
window.addEventListener('mcp_i18n_changed', () => { renderStudioProfiles(); updateStudioWorkspace(); updateStudioSummary(); });

let studioFilesRequest = 0;
async function refreshStudioFiles() {
  const request = ++studioFilesRequest;
  await Promise.all(['inputs', 'outputs'].map(async source => {
    const host = document.getElementById(`studio-recent-${source}`);
    if (!host) return;
    try {
      const response = await fetch(`/api/files/${source}`);
      if (!response.ok) throw new Error(response.status);
      const files = await response.json();
      if (request !== studioFilesRequest) return;
      files.sort((a,b) => (b.mtime || '').localeCompare(a.mtime || ''));
      host.replaceChildren();
      if (!files.length) {
        const empty = document.createElement('p');
        empty.className = 'studio-file-empty'; empty.textContent = t(`studio.empty_${source}`);
        host.append(empty);
      }
      files.slice(0, 6).forEach(file => {
        const row = document.createElement('div'); row.className = 'studio-file-row';
        const name = document.createElement('div'); name.className = 'studio-file-name';
        const title = document.createElement('strong'); title.textContent = file.name;
        const metadata = document.createElement('small');
        metadata.textContent = `${file.size_mb} MB${file.mtime ? ' · ' + new Date(file.mtime).toLocaleDateString(getLocale()) : ''}`;
        name.append(title, metadata);
        const actions = document.createElement('div'); actions.className = 'studio-file-actions';
        if (source === 'outputs') {
          const download = document.createElement('a'); download.className = 'btn btn-secondary btn-sm';
          download.textContent = t('studio.download_file');
          download.href = '/api/files/download/' + encodeURIComponent(file.rel_path);
          download.setAttribute('download', file.name); actions.append(download);
        }
        if (getFileCategory(file.name) !== 'unknown') {
          const reuse = document.createElement('button'); reuse.className = 'btn btn-secondary btn-sm';
          reuse.textContent = t('studio.reuse');
          reuse.addEventListener('click', () => {
            const category = getFileCategory(file.name);
            const tab = category === 'image' ? 'images' : category;
            studioNavigate('converter', tab);
            addFileToQueue(tab, file);
          });
          actions.append(reuse);
        }
        row.append(name, actions); host.append(row);
      });
    } catch (_) {
      if (request === studioFilesRequest) host.textContent = t('studio.files_failed');
    }
  }));
}
document.addEventListener('DOMContentLoaded', refreshStudioFiles);
window.addEventListener('mcp_i18n_changed', refreshStudioFiles);
