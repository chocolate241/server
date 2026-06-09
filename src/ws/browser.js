class BrowserHub {
  constructor({ deviceManager, logger, getStatus, onDirectCommand }) {
    this.deviceManager = deviceManager;
    this.logger = logger;
    this.getStatus = getStatus;
    this.onDirectCommand = onDirectCommand;
    this.clients = new Set();
  }

  handleConnection(ws) {
    this.clients.add(ws);
    this.logger.info("browser connected");
    ws.send(JSON.stringify({ type: "status", ...this.getStatus() }));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", async message => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === "direct_command" && data.cmd && this.onDirectCommand) {
          await this.onDirectCommand(data.cmd);
        }
      } catch (_) {}
    });
  }

  broadcast(data) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  broadcastBinary(buffer) {
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(buffer, { binary: true });
    }
  }

  broadcastStatus() {
    this.broadcast({ type: "status", ...this.getStatus() });
  }

  broadcastTranscript(text) {
    this.broadcast({ type: "transcript", text });
  }

  broadcastLog(text) {
    this.broadcast({ type: "log", text });
  }

  renderHome() {
    const escapeHtml = value => String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const lightCards = this.deviceManager.getDevices().map(device => {
      const gpio = escapeHtml(device.gpio);
      const name = escapeHtml(device.displayName || device.name || device.gpio);
      const icon = escapeHtml(name.slice(0, 1).toUpperCase());
      return `
    <div class="light-card" id="card-${gpio}">
      <div class="light-top">
        <div class="light-icon">${icon}</div>
        <div><div class="light-name">${name}</div><div class="light-desc">${gpio}</div></div>
      </div>
      <div class="toggle-row">
        <button class="btn-light btn-on" id="btn-${gpio}-on" onclick="sendLight('${gpio}_ON')">On</button>
        <button class="btn-light btn-off" id="btn-${gpio}-off" onclick="sendLight('${gpio}_OFF')">Off</button>
      </div>
    </div>`;
    }).join("");

    const pins = JSON.stringify(this.deviceManager.getDevicePins());
    const initialLights = JSON.stringify(this.deviceManager.getInitialState());

    return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Home Smart</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d0f14;--card:#13161e;--card2:#1a1e28;--border:#252a38;--accent:#4f9dff;--accent2:#36d8b0;--danger:#ff5e57;--text:#e0e4f0;--muted:#6b7591;--on:#36d8b0;--off:#334155}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:20px 12px 40px}
.wrap{width:100%;max-width:580px;display:flex;flex-direction:column;gap:14px}
.title{font-family:'Space Mono',monospace;font-size:22px;color:var(--accent);text-align:center;padding:6px 0 2px}
.subtitle{text-align:center;color:var(--muted);font-size:13px}
.statusbar{display:flex;gap:8px;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:10px 14px;font-size:13px;font-family:'Space Mono',monospace;flex-wrap:wrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--off);flex-shrink:0;transition:background .4s}
.dot.on{background:var(--on);box-shadow:0 0 6px var(--on)}
.dot.proc{background:#f59e0b;box-shadow:0 0 6px #f59e0b;animation:pulse .8s infinite alternate}
@keyframes pulse{to{opacity:.4}}
.section-label{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;padding:0 2px}
.lights{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.light-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .3s}
.light-card.active{border-color:var(--on)}
.light-top{display:flex;align-items:center;gap:10px}.light-icon{font-size:28px}.light-name{font-weight:600;font-size:15px}.light-desc{font-size:12px;color:var(--muted);margin-top:1px}
.toggle-row{display:flex;gap:8px}.btn-light{flex:1;padding:9px 0;border-radius:8px;border:none;font-family:'DM Sans',sans-serif;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s}
.btn-on{background:var(--off);color:var(--muted)}.btn-on.active{background:var(--on);color:#0d1a14}.btn-off{background:var(--off);color:var(--muted)}.btn-off.active{background:var(--danger);color:#fff}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px}.btn-record{width:100%;padding:13px;border-radius:8px;border:none;font-family:'DM Sans',sans-serif;font-weight:600;font-size:15px;cursor:pointer;background:var(--danger);color:#fff}.btn-record.recording{background:var(--off);color:var(--muted)}
.transcript-box{background:var(--card2);border-radius:8px;padding:12px 14px;font-size:14px;color:var(--on);min-height:38px;line-height:1.5}.transcript-box.listening{color:#f59e0b;animation:pulse .8s infinite alternate}
textarea{width:100%;height:80px;padding:12px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card2);color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;outline:none;resize:none}
textarea:focus{border-color:var(--accent)}.btn-send{width:100%;margin-top:8px;padding:13px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-family:'DM Sans',sans-serif;font-weight:600;font-size:15px;cursor:pointer}
.log-box{background:var(--card2);border-radius:8px;padding:14px;font-family:'Space Mono',monospace;font-size:12px;color:#8fa0c0;white-space:pre-wrap;min-height:100px;line-height:1.7}audio{width:100%;border-radius:8px}
.btn-play{width:100%;padding:11px;border-radius:8px;border:1px solid var(--border);background:var(--card2);color:var(--accent2);font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;cursor:pointer}
#netBadge{display:none;background:#7c3e0d;color:#ffbe6f;border-radius:8px;padding:6px 12px;font-size:12px;text-align:center;font-family:'Space Mono',monospace}#netBadge.show{display:block}
@media(max-width:400px){.lights{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <div><div class="title">Home Smart</div><div class="subtitle">ESP32 - Wake Word - STT - Gemini</div></div>
  <div class="statusbar"><div class="dot" id="dotEsp"></div><span>ESP32:</span><b id="lblEsp">-</b>&nbsp;|&nbsp;<div class="dot" id="dotVoice"></div><span>Voice:</span><b id="lblVoice">idle</b>&nbsp;|&nbsp;<span id="lblMem" style="color:var(--muted);font-size:12px">Memory: -</span></div>
  <div id="netBadge">Network issue - retrying...</div>
  <div class="section-label">Lights</div>
  <div class="lights">${lightCards}</div>
  <div class="card" style="display:flex;flex-direction:column;gap:10px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="monitor" onchange="toggleMonitor()" style="width:18px;height:18px;accent-color:var(--accent)"><span style="font-size:14px">Realtime audio monitor from ESP32</span></label><button class="btn-record" id="recordBtn" onclick="toggleRecord()">Record test audio</button></div>
  <div class="card" style="display:flex;flex-direction:column;gap:8px"><audio id="player" controls></audio><button class="btn-play" onclick="loadAudio('/latest-record.wav')">Play latest record</button></div>
  <div class="card" style="display:flex;flex-direction:column;gap:8px"><div class="section-label">Transcript</div><div class="transcript-box" id="transcript">No speech yet...</div></div>
  <div class="card" style="display:flex;flex-direction:column;gap:0"><div class="section-label" style="margin-bottom:8px">Manual command</div><textarea id="cmdText" placeholder="Example: bat den phong khach roi 5 giay sau tat"></textarea><button class="btn-send" onclick="sendCommand()">Send command</button></div>
  <div class="log-box" id="log">Waiting for connection...</div>
</div>
<script>
const $ = id => document.getElementById(id);
const log = $("log"), monitor = $("monitor"), player = $("player"), recordBtn = $("recordBtn"), transcript = $("transcript");
const DEVICE_PINS = ${pins};
let lights = ${initialLights};
let audioCtx = null, nextTime = 0, recording = false, ws, wsRetry = 0, wsTimer = null;
function connectWS(){const proto=location.protocol==="https:"?"wss://":"ws://";ws=new WebSocket(proto+location.host+"/?client=browser");ws.binaryType="arraybuffer";ws.onopen=()=>{wsRetry=0;$("netBadge").classList.remove("show");clearTimeout(wsTimer);fetch("/memory").then(r=>r.json()).then(d=>{$("lblMem").textContent="Memory: "+Object.keys(d).length+" commands"}).catch(()=>{})};ws.onmessage=e=>{if(typeof e.data==="string"){const d=JSON.parse(e.data);if(d.type==="status")handleStatus(d);if(d.type==="transcript")updateTranscript(d.text);if(d.type==="log")log.textContent=d.text;return}if(!monitor.checked||recording)return;playPCM(e.data)};ws.onclose=()=>{wsRetry++;const delay=Math.min(1000*Math.pow(1.5,wsRetry-1),10000);$("netBadge").classList.add("show");wsTimer=setTimeout(connectWS,delay)};ws.onerror=()=>ws.close()}
connectWS();
function handleStatus(d){recording=d.recording;lights=d.lights||{};const state=d.voiceState||"idle";$("dotEsp").className="dot"+(d.esp32Connected?" on":"");$("lblEsp").textContent=d.esp32Connected?"Connected":"No";const dotV=$("dotVoice");if(state==="capturing"){dotV.className="dot proc";$("lblVoice").textContent="Listening"}else if(state==="processing"||state==="executing"){dotV.className="dot on";$("lblVoice").textContent=state}else{dotV.className="dot";$("lblVoice").textContent="idle"}DEVICE_PINS.forEach(dev=>updateLightUI(dev,lights[dev]));recordBtn.textContent=recording?"Stop recording":"Record test audio";recordBtn.className="btn-record"+(recording?" recording":"")}
function updateTranscript(text){transcript.textContent=text||"No speech yet...";transcript.className="transcript-box"+(text==="Listening..."?" listening":"")}
function updateLightUI(dev,isOn){const card=$("card-"+dev),btnOn=$("btn-"+dev+"-on"),btnOff=$("btn-"+dev+"-off");if(!card)return;card.className="light-card"+(isOn?" active":"");btnOn.className="btn-light btn-on"+(isOn?" active":"");btnOff.className="btn-light btn-off"+(!isOn?" active":"")}
function sendLight(cmd){if(!ws||ws.readyState!==1){log.textContent="Server is not connected.";return}ws.send(JSON.stringify({type:"direct_command",cmd}));const dev=cmd.split("_")[0];lights[dev]=cmd.endsWith("_ON");updateLightUI(dev,lights[dev]);log.textContent="SEND "+cmd}
async function toggleMonitor(){if(recording){monitor.checked=false;return}if(monitor.checked&&!audioCtx){audioCtx=new AudioContext({sampleRate:16000});nextTime=audioCtx.currentTime+0.05}if(audioCtx?.state==="suspended")await audioCtx.resume();log.textContent=monitor.checked?"Realtime audio on":"Realtime audio off"}
function playPCM(ab){if(!audioCtx)return;const pcm=new Int16Array(ab);const buf=audioCtx.createBuffer(1,pcm.length,16000);const ch=buf.getChannelData(0);for(let i=0;i<pcm.length;i++)ch[i]=pcm[i]/32768;const src=audioCtx.createBufferSource();src.buffer=buf;src.connect(audioCtx.destination);if(nextTime<audioCtx.currentTime)nextTime=audioCtx.currentTime+0.03;src.start(nextTime);nextTime+=buf.duration}
async function toggleRecord(){monitor.checked=false;const res=await fetch("/record/toggle",{method:"POST"});const d=await res.json();recording=d.recording;log.textContent=recording?"Recording...":"Saved test record";if(!recording){player.src="/latest-record.wav?t="+Date.now();player.load()}}
function loadAudio(url){player.src=url+"?t="+Date.now();player.load();player.play().catch(()=>{log.textContent="No file yet or browser blocked playback."})}
$("cmdText").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendCommand()}});
async function sendCommand(){const text=$("cmdText").value.trim();if(!text)return;log.textContent="Processing...";try{const t0=Date.now();const res=await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});const d=await res.json();const total=Date.now()-t0;if(d.ok)$("cmdText").value="";log.textContent="Text: "+text+"\\n\\nSource: "+d.source+"\\nAI: "+d.duration+"ms | Total: "+total+"ms\\n\\nCommands: "+JSON.stringify(d.commands)+"\\n\\nMessage: "+d.message;fetch("/memory").then(r=>r.json()).then(dd=>{$("lblMem").textContent="Memory: "+Object.keys(dd).length+" commands"})}catch(e){log.textContent="Error: "+e.message}}
</script>
</body>
</html>`;
  }
}

module.exports = { BrowserHub };
