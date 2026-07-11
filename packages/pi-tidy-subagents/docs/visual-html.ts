import { SnapshotComponent } from "../render.js";
import { buildToolActivityBlock } from "../vendor/pi-tidy-core/index.js";
import type { ChildState, RunDetails } from "../types.js";
const colors: Record<string,string> = { "31":"#f7768e", "32":"#9ece6a", "33":"#e0af68", "35":"#bb9af7", "36":"#7dcfff" };
function ansi(value: string): string { let open=0, out="", last=0; const esc=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); const re=/\x1b\[([0-9;]*)m/g; let m; while((m=re.exec(value))){out+=esc(value.slice(last,m.index));last=re.lastIndex;for(const code of m[1].split(";").filter(Boolean).length?m[1].split(";"): ["0"]){if(code==="0"){while(open--)out+="</span>";open=0}else {out+=`<span style="${code==="1"?"font-weight:700":code==="2"?"opacity:.55":`color:${colors[code]}`}\">`;open++}}}out+=esc(value.slice(last));while(open--)out+="</span>";return out;}
const base = (index:number, status:ChildState["status"], label:string, reason:string): ChildState => {
 const input = status === "queued" ? 0 : index * 1234, output = status === "queued" ? 0 : index * 169;
 const cacheRead = status === "queued" ? 0 : index * 2048, cacheWrite = status === "queued" ? 0 : index * 12;
 const providerTraffic = input + output + cacheRead + cacheWrite;
 return { index,id:`child-${index}`,label,reason,prompt:"",status,model:"sonnet-4",thinking:"high",toolCount:status === "queued" ? 0 : index,input,output,cacheRead,cacheWrite,providerTraffic,tokens:providerTraffic,activities:[],activeTools:[],eventCount:0,response:"",artifactPath:"" };
};
const readRunning = buildToolActivityBlock("read", { path: "src/index.ts", reasoning: "inspect the extension entrypoint" }, "running");
const grepRunning = buildToolActivityBlock("grep", { pattern: "scheduler", path: "src", reasoning: "find scheduler ownership" }, "running");
const readSettled = buildToolActivityBlock("read", { path: "README.md", reasoning: "read the public contract" }, "success", { content: [{ type: "text", text: Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n") }] });
const children = [
 {...base(1,"queued","research","map the current API"),activities:[]},
 {...base(2,"running","tests","exercise parallel tools"),activities:[...readRunning,...grepRunning],activeTools:[{id:"read",name:"read",activityIndex:0},{id:"grep",name:"grep",activityIndex:2}]},
 {...base(3,"completed","docs","summarize the contract"),activities:["Read the implementation",...readSettled,"Wrote the compatibility summary"]},
 {...base(4,"warning","empty","check optional output"),error:"Child completed without assistant output"},
 {...base(5,"failed","provider","verify failure state"),activities:["✗ bash npm test"],error:"provider failed"},
 {...base(6,"cancelled","cleanup","stop abandoned work"),activities:["Inspecting artifacts"],error:"Cancelled"},
] as ChildState[];
const details: RunDetails={schemaVersion:1,runId:"demo",runDir:"",cwd:"/repo",createdAt:new Date(0).toISOString(),cap:2,runtime:{provider:"anthropic",modelId:"sonnet-4",model:"anthropic/sonnet-4",thinking:"high",activeTools:["read","grep"],projectTrusted:true},children};
const collapsed = new SnapshotComponent(details, false).render(120).join("\n");
const expanded = new SnapshotComponent({ ...details, children: [children[2]!] }, true).render(120).join("\n");
const narrow = new SnapshotComponent({ ...details, children: [children[1]!] }, false).render(58).join("\n");
const html=`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}body{display:inline-block}.frame{margin:30px;padding:35px;background:linear-gradient(135deg,#6157da,#cf6cae);border-radius:18px}.win{background:#1a1b26;color:#c0caf5;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px #0008}.bar{padding:14px 20px;background:#15161e;color:#777;font:14px monospace}.term{padding:24px 30px;font:18px/1.55 "JetBrains Mono",monospace;white-space:pre}.pending{background:#242738}.settled{background:#202d29;margin-top:18px}.narrow{width:58ch;background:#252331;border-top:18px solid #15161e}</style><div class="frame"><div class="win"><div class="bar">● ● ●　pi — tidy subagents</div><div class="term pending">${ansi(collapsed)}</div><div class="term settled">expanded detail\n${ansi(expanded)}</div><div class="term narrow">narrow viewport\n${ansi(narrow)}</div></div></div>`;process.stdout.write(html);
