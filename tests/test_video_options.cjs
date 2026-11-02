const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Select {
  constructor(value = '') { this.value = value; this.options = []; }
  replaceChildren(...options) {
    this.options = options;
    this.value = options[0]?.value || '';
  }
}
const elements = {
  'v-container': new Select('webm'), 'v-vcodec': new Select('libx264'),
  'v-acodec': new Select('aac'), 'v-crf': new Select('23'),
};
const context = vm.createContext({
  document: {getElementById: id => elements[id], addEventListener() {}},
  window: {addEventListener() {}}, useClientFFmpeg: false,
  Option: class { constructor(label, value) { this.label = label; this.value = value; } },
});
vm.runInContext(fs.readFileSync('static/js/part0-config.js', 'utf8'), context);
vm.runInContext(`
  refreshVideoCodecOptions();
`, context);
assert(elements['v-vcodec'].options.every(o => /av1|vp9|copy/.test(o.value)));
assert.equal(elements['v-acodec'].value, 'libopus');
assert.equal(elements['v-vcodec'].value, 'libsvtav1');
elements['v-container'].value = 'gif';
vm.runInContext('refreshVideoCodecOptions()', context);
assert.equal(elements['v-vcodec'].value, 'gif');
assert(elements['v-acodec'].disabled);
assert(elements['v-crf'].disabled);
let args = vm.runInContext("videoEncodingArgs('gif', '23', 'gif', '')", context);
assert(args.includes('-an'));
assert(!args.includes('-crf'));
vm.runInContext(`serverHardware = {available: true, encoders: [
  {id: 'libx264', label: 'CPU', hardware: false, quality: 'crf'},
  {id: 'h264_nvenc', label: 'NVIDIA', hardware: true, quality: 'cq'}
]}`, context);
elements['v-container'].value = 'mp4';
vm.runInContext('refreshVideoCodecOptions()', context);
assert(elements['v-vcodec'].options.some(o => o.value === 'h264_nvenc'));
args = vm.runInContext("videoEncodingArgs('h264_nvenc', '23', 'mp4', 'aac')", context);
assert(args.includes('-cq'));
assert(!args.includes('-crf'));
assert(args.includes('+faststart'));
context.useClientFFmpeg = true;
vm.runInContext('refreshVideoCodecOptions()', context);
assert(!elements['v-vcodec'].options.some(o => o.value === 'h264_nvenc'));
console.log('Video options: WebM, GIF, NVENC quality, faststart and browser isolation passed.');
vm.runInContext(`serverHardware.encoders.push(
  {id: 'h264_qsv', label: 'Intel', hardware: true, quality: 'global_quality'},
  {id: 'h264_videotoolbox', label: 'Apple', hardware: true, quality: 'q:v'}
)`, context);
args = vm.runInContext("videoEncodingArgs('h264_qsv', '23', 'mp4', 'aac')", context);
assert(args.includes('-global_quality'));
const highQuality = vm.runInContext("videoEncodingArgs('h264_videotoolbox', '15', 'mp4', 'aac')", context);
const lowQuality = vm.runInContext("videoEncodingArgs('h264_videotoolbox', '32', 'mp4', 'aac')", context);
assert(Number(highQuality[3]) > Number(lowQuality[3]));
