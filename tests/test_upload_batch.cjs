const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync('static/js/part5-library-uploads.js','utf8');
function harness(files, cancelAfterFirst=false) {
  const nodes={};for(const id of ['global-file-upload','upload-progress-wrapper','upload-progress-fill','upload-status-text','upload-cancel-btn'])
    nodes[id]={files,style:{},classList:{add(){}},value:''};
  const added=[],sent=[];let active=0,maxActive=0;
  const ctx=vm.createContext({document:{getElementById:id=>nodes[id]},currentGroup:'converter',activeConvSubTab:'video',
    tabQueues:{video:[],audio:[],images:[]},t:key=>key==='studio.upload_finished'?'{done}/{failed}':key,
    showToast(){},refreshFiles:async()=>{},refreshStudioFiles(){},addFileToQueue:(tab,file)=>added.push({tab,file}),
    getFileCategory:name=>name.endsWith('.mp3')?'audio':'video',
    FormData:class {append(key,file){this.file=file;}},
    XMLHttpRequest:class {
      constructor(){this.upload={};}open(){}abort(){this.cancelled=true;active--;this.onabort();}
      send(body){sent.push(body.file.name);active++;maxActive=Math.max(maxActive,active);
        setTimeout(()=>{if(this.cancelled)return;active--;
          this.status=body.file.name==='bad.mp4'?507:200;
          this.responseText=JSON.stringify(this.status===200?{filename:body.file.name,path:'/inputs/'+body.file.name,size_mb:1}:{detail:'full'});
          this.onload();if(cancelAfterFirst) vm.runInContext('cancelFileUpload()',ctx);
        },0);
      }
    }
  });
  vm.runInContext(source.slice(0,source.indexOf('async function resetGuiAndRefresh')),ctx);
  return {ctx,added,sent,nodes,max:()=>maxActive};
}
(async()=>{
  const batch=harness([{name:'one.mp4',size:10},{name:'bad.mp4',size:10},{name:'audio.mp3',size:10}]);
  await vm.runInContext('uploadSelectedFileWithProgress()',batch.ctx);
  assert.deepEqual(batch.sent,['one.mp4','bad.mp4','audio.mp3']);
  assert.deepEqual(batch.added.map(x=>x.tab),['video','audio']);
  assert.equal(batch.max(),1);assert.equal(batch.nodes['upload-status-text'].textContent,'2/1');
  const cancelled=harness([{name:'one.mp4',size:10},{name:'two.mp4',size:10}],true);
  await vm.runInContext('uploadSelectedFileWithProgress()',cancelled.ctx);
  assert.deepEqual(cancelled.sent,['one.mp4']);assert.equal(cancelled.added.length,1);
  console.log('Batch uploads passed: sequential processing, partial failure, media routing and cancellation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
