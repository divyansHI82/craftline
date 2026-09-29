const { performance }=require('node:perf_hooks');
const fs=require('node:fs');
const path=require('node:path');
const envPath=path.resolve(__dirname,'..','.env');
if(fs.existsSync(envPath))for(const row of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){const match=row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2')}

const base=String(process.env.BENCHMARK_BASE_URL||'').replace(/\/$/,'');
if(!/^https?:\/\//i.test(base)){console.error('Set BENCHMARK_BASE_URL to the deployed Craftline URL.');process.exit(1)}
const concurrency=Math.max(1,Math.min(32,Number.parseInt(process.env.BENCHMARK_CONCURRENCY||'8',10)||8));
const rounds=Math.max(1,Math.min(20,Number.parseInt(process.env.BENCHMARK_ROUNDS||'5',10)||5));
const percentile=(values,p)=>values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];

async function sample(path,headers={}){
 const times=[],sizes=[];
 for(let round=0;round<rounds;round++){
  const batch=await Promise.all(Array.from({length:concurrency},async()=>{
   const start=performance.now(),response=await fetch(`${base}${path}`,{headers,redirect:'manual'});
   if(!response.ok)throw new Error(`${path} returned HTTP ${response.status}`);
   const body=await response.arrayBuffer();return {ms:performance.now()-start,bytes:body.byteLength};
  }));
  for(const result of batch){times.push(result.ms);sizes.push(result.bytes)}
 }
 return `${path}: median ${percentile(times,.5).toFixed(1)} ms, p95 ${percentile(times,.95).toFixed(1)} ms, average body ${(sizes.reduce((a,b)=>a+b,0)/sizes.length/1024).toFixed(1)} KB`;
}

(async()=>{
 console.log(`Read-only hosted benchmark for ${base} (${concurrency} concurrent requests, ${rounds} rounds).`);
 console.log('Use the result as an observation for this host and time window, not as a production capacity guarantee.');
 console.log(await sample('/api/health'));
 console.log(await sample('/api/bootstrap'));
 console.log(await sample('/app.js?v=host-benchmark',{'accept-encoding':'gzip'}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
