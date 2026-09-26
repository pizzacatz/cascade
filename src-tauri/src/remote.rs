//! Remote Stack: control a running Stack from a phone on the same network.
//!
//! When the user turns it on, a tiny HTTP server listens on the LAN and serves
//! one self-contained page plus two endpoints:
//!
//! - `GET  /?t=<token>`                 the remote-control page
//! - `GET  /state?t=<token>&since=<v>`  the stack state as JSON (long-poll:
//!   waits up to ~25 s for a version newer than `since`)
//! - `POST /cmd?t=<token>`              body `complete|incomplete|next|previous|pause`
//!
//! Every request must carry the random per-session token (403 otherwise). The
//! server only knows the stack state the frontend pushes to it — never the
//! document — and stops when the stack stops or the user turns it off.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The event the frontend listens to for commands pressed on the phone.
pub const COMMAND_EVENT: &str = "remote-stack-command";

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_CONNECTIONS: usize = 16;
const LONG_POLL: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteCommand {
    Complete,
    Incomplete,
    Next,
    Previous,
    Pause,
}

impl RemoteCommand {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "complete" => Some(Self::Complete),
            "incomplete" => Some(Self::Incomplete),
            "next" => Some(Self::Next),
            "previous" => Some(Self::Previous),
            "pause" => Some(Self::Pause),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Incomplete => "incomplete",
            Self::Next => "next",
            Self::Previous => "previous",
            Self::Pause => "pause",
        }
    }
}

/// Compare the presented token with the expected one in constant time.
pub fn token_matches(expected: &str, presented: Option<&str>) -> bool {
    let Some(p) = presented else { return false };
    let (a, b) = (expected.as_bytes(), p.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A 256-bit random token as hex.
fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Look up a query parameter (no percent-decoding needed for our values).
fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == key).then_some(v)
    })
}

/// The address phones on the LAN can reach: the interface of the default
/// route (a UDP "connect" sends no packets), else loopback.
fn lan_ip() -> IpAddr {
    let probe = || -> Option<IpAddr> {
        let s = UdpSocket::bind("0.0.0.0:0").ok()?;
        s.connect("192.0.2.1:80").ok()?; // TEST-NET-1; nothing is sent
        let ip = s.local_addr().ok()?.ip();
        (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
    };
    probe().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

/// Latest stack state pushed by the frontend, with a version for long-polls.
struct Shared {
    snapshot: Mutex<(u64, String)>,
    changed: Condvar,
    stop: AtomicBool,
    connections: AtomicUsize,
}

struct Server {
    shared: Arc<Shared>,
    info: RemoteInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub url: String,
    pub qr_svg: String,
}

#[derive(Default)]
pub struct RemoteState {
    server: Mutex<Option<Server>>,
}

impl RemoteState {
    fn stop(&self) {
        if let Some(server) = self.server.lock().unwrap().take() {
            let sh = &server.shared;
            sh.stop.store(true, Ordering::SeqCst);
            let mut snap = sh.snapshot.lock().unwrap();
            snap.0 += 1;
            snap.1 = r#"{"stopped":true}"#.into();
            sh.changed.notify_all();
        }
    }
}

fn qr_svg(text: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::new(text.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(180, 180)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

/// Start the server (or return the running one's URL).
#[tauri::command]
pub fn remote_stack_start(app: AppHandle, state: State<'_, RemoteState>) -> Result<RemoteInfo, String> {
    let mut guard = state.server.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        return Ok(s.info.clone());
    }
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0))).map_err(|e| format!("Could not open a network port: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token();
    let url = format!("http://{}:{}/?t={}", lan_ip(), port, token);
    let shared = Arc::new(Shared {
        snapshot: Mutex::new((1, r#"{"running":false}"#.into())),
        changed: Condvar::new(),
        stop: AtomicBool::new(false),
        connections: AtomicUsize::new(0),
    });
    let info = RemoteInfo { qr_svg: qr_svg(&url), url };
    {
        let shared = shared.clone();
        let token = token.clone();
        std::thread::Builder::new()
            .name("remote-stack".into())
            .spawn(move || accept_loop(listener, shared, token, app))
            .map_err(|e| e.to_string())?;
    }
    log::info!("Remote Stack listening on port {port}");
    *guard = Some(Server { shared, info: info.clone() });
    Ok(info)
}

#[tauri::command]
pub fn remote_stack_stop(state: State<'_, RemoteState>) {
    state.stop();
}

/// Replace the state the phone sees. `state` is the frontend's JSON payload.
#[tauri::command]
pub fn remote_stack_update(state: State<'_, RemoteState>, payload: serde_json::Value) {
    if let Some(server) = state.server.lock().unwrap().as_ref() {
        let text = payload.to_string();
        let mut snap = server.shared.snapshot.lock().unwrap();
        if snap.1 != text {
            snap.0 += 1;
            snap.1 = text;
            server.shared.changed.notify_all();
        }
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<Shared>, token: String, app: AppHandle) {
    while !shared.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if shared.connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    drop(stream);
                    continue;
                }
                shared.connections.fetch_add(1, Ordering::SeqCst);
                let (shared, token, app) = (shared.clone(), token.clone(), app.clone());
                std::thread::spawn(move || {
                    let _ = handle(stream, &shared, &token, &app);
                    shared.connections.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    log::info!("Remote Stack stopped");
}

struct Request {
    method: String,
    path: String,
    query: String,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_REQUEST_BYTES {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if len > 1024 {
        return None;
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    Some(Request { method, path: path.to_string(), query: query.to_string(), body: String::from_utf8_lossy(&body).to_string() })
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\
         Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// What a request should get, independent of the socket (unit-tested).
#[derive(Debug, PartialEq, Eq)]
enum Route {
    Page,
    State { since: u64 },
    Command(RemoteCommand),
    Forbidden,
    BadRequest,
    NotFound,
}

fn route(token: &str, method: &str, path: &str, query: &str, body: &str) -> Route {
    if !token_matches(token, query_param(query, "t")) {
        return Route::Forbidden;
    }
    match (method, path) {
        ("GET", "/") => Route::Page,
        ("GET", "/state") => Route::State { since: query_param(query, "since").and_then(|v| v.parse().ok()).unwrap_or(0) },
        ("POST", "/cmd") => RemoteCommand::parse(body).map(Route::Command).unwrap_or(Route::BadRequest),
        _ => Route::NotFound,
    }
}

fn handle(mut stream: TcpStream, shared: &Shared, token: &str, app: &AppHandle) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let Some(req) = read_request(&mut stream) else {
        return respond(&mut stream, "400 Bad Request", "text/plain", "Bad request");
    };
    match route(token, &req.method, &req.path, &req.query, &req.body) {
        Route::Page => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE),
        Route::State { since } => {
            let deadline = Instant::now() + LONG_POLL;
            let mut snap = shared.snapshot.lock().unwrap();
            while snap.0 <= since && !shared.stop.load(Ordering::SeqCst) {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                snap = shared.changed.wait_timeout(snap, left).unwrap().0;
            }
            let body = format!(r#"{{"version":{},"state":{}}}"#, snap.0, snap.1);
            drop(snap);
            respond(&mut stream, "200 OK", "application/json", &body)
        }
        Route::Command(cmd) => {
            let _ = app.emit(COMMAND_EVENT, cmd.as_str());
            respond(&mut stream, "204 No Content", "text/plain", "")
        }
        Route::Forbidden => respond(&mut stream, "403 Forbidden", "text/plain", "Forbidden"),
        Route::BadRequest => respond(&mut stream, "400 Bad Request", "text/plain", "Unknown command"),
        Route::NotFound => respond(&mut stream, "404 Not Found", "text/plain", "Not found"),
    }
}

const PAGE: &str = r##"<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Cascade Stack</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--accent:#3b6fd8;--ok:#2f8f5b;--line:#e3e0da}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eceae6;--muted:#9a978f;--card:#222120;--accent:#7aa2ff;--ok:#5cc28a;--line:#34322f}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;
padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
.meta{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:14px}
.label{font-weight:650;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card{flex:1;display:flex;flex-direction:column;justify-content:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0;min-height:180px}
.crumbs{color:var(--muted);font-size:14px}
.task{font-size:clamp(22px,6vw,34px);font-weight:650;word-break:break-word}
.task.done{text-decoration:line-through;color:var(--muted)}
.timer{font-variant-numeric:tabular-nums;font-size:20px;color:var(--muted)}
.timer.break{color:var(--ok)}.timer.over{color:#d24a3c}
.bar{height:6px;border-radius:6px;background:var(--line);overflow:hidden;margin-bottom:14px}.bar>div{height:100%;background:var(--accent);transition:width .3s}
.row{display:flex;gap:10px}
button{flex:1;font:inherit;font-weight:600;padding:16px 10px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--fg);touch-action:manipulation}
button:disabled{opacity:.4}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-size:18px;padding:20px}
.msg{text-align:center;color:var(--muted)}
</style></head><body>
<div class="meta"><span class="label" id="label">Stack</span><span id="count"></span></div>
<div class="card" id="card"><div class="msg">Connecting…</div></div>
<div class="bar"><div id="bar" style="width:0"></div></div>
<div class="row" style="margin-bottom:10px"><button class="primary" id="main" disabled>Mark complete</button></div>
<div class="row"><button id="prev" disabled>‹ Previous</button><button id="pause" disabled>Pause</button><button id="next" disabled>Next ›</button></div>
<script>
(function(){
var t=new URLSearchParams(location.search).get("t")||"";
var q="?t="+encodeURIComponent(t);
var st=null,got=0,version=0,ended=false;
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function fmt(ms){var s=Math.floor(Math.abs(ms)/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
 var mm=String(m).padStart(2,"0"),ss=String(x).padStart(2,"0");return (ms<0?"+":"")+(h?h+":"+mm+":"+ss:mm+":"+ss)}
function timerText(){var tm=st&&st.timer;if(!tm)return"";var dt=tm.paused?0:Date.now()-got;
 if(tm.type==="none")return fmt(tm.elapsedMs+dt);var r=tm.remainingMs-dt;if(tm.type==="pomodoro")r=Math.max(0,r);return fmt(r)}
function render(){
 var card=$("card");
 if(ended||!st||st.stopped){card.innerHTML='<div class="msg">Remote control has ended.</div>';setButtons(false);return}
 if(!st.running&&!st.allDone){card.innerHTML='<div class="msg">No Stack is running.</div>';setButtons(false);return}
 $("label").textContent="Stack · "+(st.label||"");
 $("count").textContent=st.done+" / "+st.total;
 $("bar").style.width=(st.total?st.done/st.total*100:0)+"%";
 if(st.allDone){card.innerHTML='<div class="msg task">🎉 All Done!</div>';setButtons(false);return}
 var tm=st.timer,cls=tm&&tm.phase==="break"?"break":tm&&tm.phase==="overtime"?"over":"";
 var html="";
 if(st.onBreak)html+='<div class="task">☕ Break</div>';
 else{if(st.breadcrumb&&st.breadcrumb.length)html+='<div class="crumbs">'+esc(st.breadcrumb.join(" › "))+'</div>';
  html+='<div class="task'+(st.itemDone?" done":"")+'">'+esc(st.text||"—")+'</div>'}
 if(tm)html+='<div class="timer '+cls+'" id="timer">'+timerText()+(tm.paused?" · paused":"")+'</div>';
 card.innerHTML=html;
 setButtons(true);
 $("main").textContent=st.itemDone?"Mark incomplete":"Mark complete";
 $("prev").disabled=!st.canPrevious;$("next").disabled=!st.canNext;
 $("pause").hidden=!tm||tm.type==="none";$("pause").textContent=tm&&tm.paused?"Resume":"Pause";
}
function setButtons(on){["main","prev","next","pause"].forEach(function(id){$(id).disabled=!on})}
function send(cmd){fetch("cmd"+q,{method:"POST",body:cmd}).catch(function(){})}
$("main").onclick=function(){send(st&&st.itemDone?"incomplete":"complete")};
$("prev").onclick=function(){send("previous")};$("next").onclick=function(){send("next")};$("pause").onclick=function(){send("pause")};
setInterval(function(){var el=$("timer");if(el&&st&&st.timer)el.textContent=timerText()+(st.timer.paused?" · paused":"")},500);
function poll(){
 fetch("state"+q+"&since="+version).then(function(r){if(r.status===403){ended=true;render();throw 0}return r.json()})
 .then(function(j){version=j.version;st=j.state;got=Date.now();render();if(st.stopped){ended=true;return}poll()})
 .catch(function(e){if(e===0||ended)return;setTimeout(poll,2000)});
}
poll();
})();
</script></body></html>"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_check_is_exact() {
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert!(token_matches(&t, Some(&t)));
        assert!(!token_matches(&t, None));
        assert!(!token_matches(&t, Some("")));
        assert!(!token_matches(&t, Some(&t[..63])));
        let mut wrong = t.clone();
        wrong.replace_range(0..1, if &t[0..1] == "a" { "b" } else { "a" });
        assert!(!token_matches(&t, Some(&wrong)));
        assert!(!token_matches("", Some("")));
        assert_ne!(new_token(), new_token());
    }

    #[test]
    fn commands_parse() {
        for c in ["complete", "incomplete", "next", "previous", "pause"] {
            assert_eq!(RemoteCommand::parse(c).unwrap().as_str(), c);
        }
        assert_eq!(RemoteCommand::parse(" next\n"), Some(RemoteCommand::Next));
        assert_eq!(RemoteCommand::parse("delete"), None);
        assert_eq!(RemoteCommand::parse(""), None);
    }

    #[test]
    fn routing_requires_the_token() {
        let tok = "abc123";
        assert_eq!(route(tok, "GET", "/", "", ""), Route::Forbidden);
        assert_eq!(route(tok, "GET", "/", "t=wrong", ""), Route::Forbidden);
        assert_eq!(route(tok, "GET", "/state", "since=3", ""), Route::Forbidden);
        assert_eq!(route(tok, "POST", "/cmd", "", "next"), Route::Forbidden);
        assert_eq!(route(tok, "GET", "/", "t=abc123", ""), Route::Page);
        assert_eq!(route(tok, "GET", "/state", "t=abc123&since=7", ""), Route::State { since: 7 });
        assert_eq!(route(tok, "GET", "/state", "since=x&t=abc123", ""), Route::State { since: 0 });
        assert_eq!(route(tok, "POST", "/cmd", "t=abc123", "complete"), Route::Command(RemoteCommand::Complete));
        assert_eq!(route(tok, "POST", "/cmd", "t=abc123", "rm -rf"), Route::BadRequest);
        assert_eq!(route(tok, "GET", "/cmd", "t=abc123", "next"), Route::NotFound);
        assert_eq!(route(tok, "GET", "/doc", "t=abc123", ""), Route::NotFound);
    }

    #[test]
    fn qr_renders_svg() {
        let svg = qr_svg("http://192.168.1.2:4567/?t=abcdef");
        assert!(svg.contains("<svg"));
    }
}
