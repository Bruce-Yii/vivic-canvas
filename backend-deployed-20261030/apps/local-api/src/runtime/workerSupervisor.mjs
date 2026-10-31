import { spawn } from "node:child_process";
// The API never owns a naked Python process: disconnect always reaps the worker.
let worker, stopping=false;
function stop(){if(stopping)return;stopping=true;if(!worker||worker.exitCode!==null)process.exit(0);worker.kill();const t=setTimeout(()=>worker.kill("SIGKILL"),1000);t.unref();}
process.once("disconnect",stop);process.once("SIGINT",stop);process.once("SIGTERM",stop);
process.on("message",config=>{
 if(stopping||!process.connected||!config)return;
 if(config.kind==="start"&&!worker){
  worker=spawn(config.executable,config.args,{env:process.env,windowsHide:true,stdio:["pipe","pipe","ignore"]});
  worker.once("error",()=>process.exit(1));worker.once("close",()=>process.exit(stopping?0:1));worker.stdin.on("error",stop);
  let buffer="";worker.stdout.on("data",data=>{buffer+=data.toString("utf8");if(buffer.length>4*1024*1024)return stop();const lines=buffer.split("\n");buffer=lines.pop();for(const line of lines){try{if(process.connected)process.send(JSON.parse(line));}catch{stop();}}});
  worker.stdin.write(JSON.stringify(config.setup)+"\n");
 }else if(config.kind==="request"&&worker){const line=JSON.stringify(config.payload);if(line.length>16384)return stop();worker.stdin.write(line+"\n");}
});
if(!process.connected)stop();
