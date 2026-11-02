const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const fields = Object.fromEntries(Object.entries({
  'v-custom-title': '', 'v-container': 'mp4', 'v-vcodec': 'libx264', 'v-acodec': 'aac',
  'v-crf': '23', 'v-trim-start': '', 'v-trim-end': '', 'studio-resolution': 'source', 'studio-fps': 'source',
}).map(([key,value])=>[key,{value}]));
fields['studio-mute']={checked:false};
const context = vm.createContext({
  document:{getElementById:id=>fields[id],addEventListener(){}},
  window:{addEventListener(){}}, t:key=>key, useClientFFmpeg:false,
  tabQueues:{video:[]}, serverMediaPaths:{outputs:'/media/outputs'},
  renderTabQueue(){}, showToast(){}, console,
});
for (const name of ['part0-config.js','part2-conversion-jobs.js','part11-studio.js'])
  vm.runInContext(fs.readFileSync(`static/js/${name}`,'utf8'),context);
const settings={container:'mp4',codec:'libx264',audio:'aac',quality:'23',resolution:'480',fps:'24',mute:true,start:'0.2',end:'0.8'};
context.settings=settings;
assert.equal(vm.runInContext("studioTimeSeconds('01:02:03.5')",context),3723.5);
assert(Number.isNaN(vm.runInContext("studioTimeSeconds('00:99:00')",context)));
assert.equal(vm.runInContext('studioValidate(settings)',context),'');
context.copySettings={...settings,codec:'copy'};
assert.equal(vm.runInContext('studioValidate(copySettings)',context),'studio.copy_conflict');
context.badTrim={...settings,end:'0.1'};
assert.equal(vm.runInContext('studioValidate(badTrim)',context),'studio.trim_invalid');
let args=vm.runInContext("buildStudioVideoCommand('in.mp4','out.mp4',settings)",context);
assert.equal(args[args.indexOf('-t')+1],String(0.8-0.2));
assert(args.includes('-an'));
assert(!args.includes('-c:a'));
assert(args[args.indexOf('-vf')+1].includes('fps=24'));
// A failed API submission must keep its file available for retry.
context.tabQueues.video=[{name:'keep.mp4',path:'/inputs/keep.mp4'}];
context.submitJob=async()=>undefined;
(async()=>{
  await vm.runInContext('submitServerVideoJobs([...tabQueues.video])',context);
  assert.equal(context.tabQueues.video.length,1);
  context.submitJob=async()=>({id:'accepted'});
  await vm.runInContext('submitServerVideoJobs([...tabQueues.video])',context);
  assert.equal(context.tabQueues.video.length,0);
  try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); }
  catch { console.log('Studio logic passed; FFmpeg integration skipped (not installed).');return; }
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'media-studio-'));
  try {
    const input=path.join(tmp,'source.mp4'), output=path.join(tmp,'result.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=size=1280x720:rate=30:duration=1',
      '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',input]);
    context.input=input;context.output=output;
    args=vm.runInContext('buildStudioVideoCommand(input,output,settings)',context);
    execFileSync('ffmpeg',args,{stdio:'pipe'});
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
    assert(!info.streams.some(s=>s.codec_type==='audio'));
    const video=info.streams.find(s=>s.codec_type==='video');
    assert.equal(video.width,852);assert.equal(video.height,480); // aspect-preserving downscale
    assert.equal(video.r_frame_rate,'24/1');
    assert(Math.abs(Number(info.format.duration)-0.6)<0.1);
    context.largeSettings={...settings,resolution:'1080'};
    context.largeOutput=path.join(tmp,'no-upscale.mp4');
    const largeArgs=vm.runInContext('buildStudioVideoCommand(input,largeOutput,largeSettings)',context);
    execFileSync('ffmpeg',largeArgs,{stdio:'pipe'});
    const preserved=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',context.largeOutput],{encoding:'utf8'}));
    assert.equal(preserved.streams[0].width,1280);assert.equal(preserved.streams[0].height,720);
    console.log('Studio passed: trim, validation, failed-job retention, real mute/resize/FPS conversion.');
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
