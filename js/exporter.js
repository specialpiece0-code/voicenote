/* VN.exporter — TXT/DOC/SRT/VTT/JSON/공유 HTML/백업 생성 */
window.VN = window.VN || {};

VN.exporter = (function () {
  const U = () => VN.util;

  /* 구형(문자열 todos·decisions 없음)/신형 요약을 모두 같은 형태로 다룬다 */
  function normSummary(sum) {
    return VN.summarizer.normalizeSummary(sum);
  }

  function speakerName(note, idx) {
    const sp = (note.speakers || [])[idx];
    return (sp && sp.name) || VN.util.speakerDefaultName(idx || 0);
  }

  function srtTime(sec) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
  }
  function vttTime(sec) { return srtTime(sec).replace(',', '.'); }

  /* ── TXT ── */
  function toTXT(note, opts) {
    opts = Object.assign({ speaker: true, time: true, memos: true }, opts || {});
    const lines = [];
    lines.push(note.title || '제목 없음');
    lines.push('생성일: ' + U().fmtDate(note.createdAt) + '  길이: ' + U().fmtTime(note.duration));
    lines.push('');
    for (const s of (note.segments || [])) {
      let prefix = '';
      if (opts.time) prefix += '[' + U().fmtTime(s.start) + '] ';
      if (opts.speaker) prefix += speakerName(note, s.speaker) + ': ';
      lines.push(prefix + (s.text || ''));
    }
    if (opts.memos && (note.memos || []).length) {
      lines.push('');
      lines.push('--- 메모 ---');
      for (const m of note.memos) lines.push('[' + U().fmtTime(m.time) + '] ' + m.text);
    }
    if (note.summary && note.summary.summary) {
      const sum = normSummary(note.summary);
      lines.push('');
      lines.push('--- AI 요약 ---');
      if (sum.type) lines.push('유형: ' + sum.type);
      lines.push(sum.summary);
      for (const sec of sum.sections) {
        lines.push('');
        lines.push(sec.title + ':');
        for (const it of sec.items) lines.push('- ' + it);
      }
      if (sum.decisions.length) {
        lines.push('');
        lines.push('결정 사항:');
        for (const d of sum.decisions) lines.push('- ' + d);
      }
      if (sum.openIssues.length) {
        lines.push('');
        lines.push('미결 안건:');
        for (const o of sum.openIssues) lines.push('- ' + o);
      }
      if (sum.todos.length) {
        lines.push('');
        lines.push('담당자별 할 일:');
        for (const g of VN.summarizer.groupTodosByOwner(sum.todos)) {
          lines.push('[' + g.owner + ']');
          for (const t of g.items) lines.push('- ' + t.task + (t.due ? ' (기한: ' + t.due + ')' : ''));
        }
      }
    }
    return lines.join('\r\n');
  }

  /* ── DOC (Word 호환 HTML) ── */
  function toDOC(note, opts) {
    opts = Object.assign({ speaker: true, time: true, memos: true }, opts || {});
    const esc = U().esc;
    const usedSpeakers = [...new Set((note.segments || []).map(s => s.speaker || 0))].sort((a, b) => a - b);
    let body = '<h1>' + esc(note.title) + '</h1>' +
      '<p style="color:#888">생성일: ' + esc(U().fmtDate(note.createdAt)) + ' / 길이: ' + esc(U().fmtTime(note.duration)) + '</p>';
    if (usedSpeakers.length) {
      body += '<p style="color:#888">참석자: ' + esc(usedSpeakers.map(i => speakerName(note, i)).join(', ')) + '</p>';
    }
    for (const s of (note.segments || [])) {
      let head = '';
      if (opts.time) head += '<span style="color:#03C75A">[' + U().fmtTime(s.start) + ']</span> ';
      if (opts.speaker) head += '<b>' + esc(speakerName(note, s.speaker)) + '</b>: ';
      body += '<p>' + head + esc(s.text) + '</p>';
    }
    if (opts.memos && (note.memos || []).length) {
      body += '<h2>메모</h2>';
      for (const m of note.memos) body += '<p>[' + U().fmtTime(m.time) + '] ' + esc(m.text) + '</p>';
    }
    if (note.summary && note.summary.summary) {
      const sum = normSummary(note.summary);
      body += '<h2>AI 요약' + (sum.type ? ' <span style="font-size:12px;color:#02A94D">[' + esc(sum.type) + ']</span>' : '') + '</h2>' +
        '<p>' + esc(sum.summary).replace(/\n/g, '<br>') + '</p>';
      for (const sec of sum.sections) {
        body += '<h3>' + esc(sec.title) + '</h3><ul>' + sec.items.map(it => '<li>' + esc(it) + '</li>').join('') + '</ul>';
      }
      if (sum.decisions.length) {
        body += '<h3>결정 사항</h3><ul>' + sum.decisions.map(d => '<li>' + esc(d) + '</li>').join('') + '</ul>';
      }
      if (sum.openIssues.length) {
        body += '<h3>미결 안건</h3><ul>' + sum.openIssues.map(o => '<li>' + esc(o) + '</li>').join('') + '</ul>';
      }
      if (sum.todos.length) {
        body += '<h3>담당자별 할 일</h3>' + VN.summarizer.groupTodosByOwner(sum.todos).map(g =>
          '<p style="margin:6px 0 2px"><b>' + esc(g.owner) + '</b></p><ul>' + g.items.map(t =>
            '<li>' + esc(t.task) + (t.due ? ' <span style="color:#888">(기한: ' + esc(t.due) + ')</span>' : '') + '</li>'
          ).join('') + '</ul>').join('');
      }
      if (sum.topics.length) {
        body += '<h3>주요 주제</h3><ul>' + sum.topics.map(t =>
          '<li>[' + U().fmtTime(t.start || 0) + '] <b>' + esc(t.title) + '</b>' + (t.summary ? ' — ' + esc(t.summary) : '') + '</li>').join('') + '</ul>';
      }
    }
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
      '<head><meta charset="utf-8"><title>' + esc(note.title) + '</title></head><body>' + body + '</body></html>';
  }

  /* ── SRT / VTT ── */
  function toSRT(note) {
    const segs = (note.segments || []).filter(s => s.text);
    return segs.map((s, i) =>
      (i + 1) + '\r\n' + srtTime(s.start) + ' --> ' + srtTime(s.end || s.start + 2) + '\r\n' +
      speakerName(note, s.speaker) + ': ' + s.text + '\r\n'
    ).join('\r\n');
  }
  /* VTT 큐 텍스트 이스케이프 — & < > 는 마크업으로 해석되므로 치환 */
  function vttEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function toVTT(note) {
    const segs = (note.segments || []).filter(s => s.text);
    return 'WEBVTT\n\n' + segs.map((s) =>
      vttTime(s.start) + ' --> ' + vttTime(s.end || s.start + 2) + '\n' +
      '<v ' + vttEsc(speakerName(note, s.speaker)) + '>' + vttEsc(s.text) + '\n'
    ).join('\n');
  }

  /* ── JSON ── */
  async function toJSON(note, includeAudio) {
    const copy = Object.assign({}, note);
    delete copy.audioBlob;
    if (includeAudio && note.audioBlob instanceof Blob) {
      copy.audioB64 = await U().blobToBase64(note.audioBlob);
      copy.audioType = note.audioBlob.type || note.audioType;
    }
    return JSON.stringify(copy, null, 2);
  }

  /* ── 다운로드 헬퍼 ── */
  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function safeName(s) {
    return String(s || 'note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  /* ── WebCrypto AES-GCM + PBKDF2 ── */
  async function encryptJSON(obj, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { salt: b64(salt), iv: b64(iv), data: b64(ct) };
  }

  /* ── 공유용 단일 HTML (자체 뷰어 내장, 선택: 오디오 포함 / 비밀번호 암호화) ── */
  async function toShareHTML(note, opts) {
    opts = opts || {};
    const payload = {
      title: note.title,
      createdAt: note.createdAt,
      duration: note.duration,
      language: note.language,
      speakers: note.speakers,
      segments: note.segments,
      memos: note.memos,
      summary: note.summary ? normSummary(note.summary) : note.summary
    };
    if (opts.includeAudio && note.audioBlob instanceof Blob) {
      payload.audioDataURL = await U().blobToDataURL(note.audioBlob);
    }
    let dataScript, encrypted = false;
    if (opts.password) {
      encrypted = true;
      const enc = await encryptJSON(payload, opts.password);
      dataScript = 'var VN_ENC = ' + JSON.stringify(enc) + ';';
    } else {
      dataScript = 'var VN_DATA = ' + JSON.stringify(payload).replace(/<\//g, '<\\/') + ';';
    }
    const esc = U().esc;
    // 뷰어(단일 파일, 외부 의존성 없음)
    return '<!DOCTYPE html>\n<html lang="ko"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + esc(note.title) + ' - 보이스노트 공유</title>' +
'<style>' +
'body{font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1a1d21;line-height:1.6}' +
'h1{font-size:22px}.meta{color:#888;font-size:13px;margin-bottom:16px}' +
'.seg{display:flex;gap:10px;padding:6px 0}.sp{flex:0 0 auto;width:28px;height:28px;border-radius:50%;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}' +
'.t{color:#aaa;font-size:12px}.hl{background:#FFF3B0;border-radius:3px;padding:0 2px}' +
'.box{border:1px solid #e5e8eb;border-radius:10px;padding:14px 16px;margin:14px 0}' +
'.box h2{font-size:15px;margin:0 0 8px;color:#02A94D}' +
'audio{width:100%;margin:12px 0}' +
'#pw{max-width:340px;margin:80px auto;text-align:center}' +
'#pw input{padding:10px;width:100%;box-sizing:border-box;font-size:15px;border:1px solid #ccc;border-radius:8px}' +
'#pw button{margin-top:10px;padding:10px 22px;background:#03C75A;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}' +
'.err{color:#E5484D;font-size:13px;margin-top:8px}' +
'.badge{display:inline-block;background:#E6F9EF;color:#02A94D;border-radius:99px;padding:2px 10px;font-size:12px;margin-right:4px}' +
'</style></head><body>' +
'<div id="root"></div>' +
'<script>' + dataScript + '<\/script>' +
'<script>\n' +
'var COLORS=["#03C75A","#4C7CFF","#F5A623","#E5484D","#9B59B6","#16A2B8"];\n' +
'function fmt(s){s=Math.max(0,Math.floor(s||0));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;var mm=(m<10?"0":"")+m,ss=(x<10?"0":"")+x;return h>0?h+":"+mm+":"+ss:mm+":"+ss}\n' +
'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}\n' +
'function render(d){\n' +
'  var el=document.getElementById("root");\n' +
'  var h="<h1>"+esc(d.title)+"</h1><div class=meta>"+new Date(d.createdAt).toLocaleString("ko-KR")+" · 길이 "+fmt(d.duration)+" · 보이스노트로 공유됨</div>";\n' +
'  if(d.audioDataURL)h+="<audio controls src=\\""+d.audioDataURL+"\\"></audio>";\n' +
'  if(d.summary&&d.summary.summary){h+="<div class=box><h2>AI 요약"+(d.summary.type?" · "+esc(d.summary.type):"")+"</h2><div>"+esc(d.summary.summary).replace(/\\n/g,"<br>")+"</div>";\n' +
'    if(d.summary.sections&&d.summary.sections.length){d.summary.sections.forEach(function(s){h+="<h2 style=margin-top:12px>"+esc(s.title)+"</h2><ul>";(s.items||[]).forEach(function(x){h+="<li>"+esc(x)+"</li>"});h+="</ul>"})}\n' +
'    if(d.summary.decisions&&d.summary.decisions.length){h+="<h2 style=margin-top:12px>결정 사항</h2><ul>";d.summary.decisions.forEach(function(x){h+="<li>"+esc(x)+"</li>"});h+="</ul>"}\n' +
'    if(d.summary.openIssues&&d.summary.openIssues.length){h+="<h2 style=margin-top:12px>미결 안건</h2><ul>";d.summary.openIssues.forEach(function(x){h+="<li>"+esc(x)+"</li>"});h+="</ul>"}\n' +
'    if(d.summary.todos&&d.summary.todos.length){h+="<h2 style=margin-top:12px>담당자별 할 일</h2><ul>";d.summary.todos.forEach(function(t){\n' +
'      var task=(t&&typeof t==="object")?t.task:t, owner=(t&&typeof t==="object")?t.owner:"", due=(t&&typeof t==="object")?t.due:"";\n' +
'      h+="<li>"+(owner?"<b>"+esc(owner)+"</b>: ":"")+esc(task)+(due?" <span style=color:#888>(기한: "+esc(due)+")</span>":"")+"</li>"});h+="</ul>"}\n' +
'    if(d.summary.keywords&&d.summary.keywords.length){h+="<div style=margin-top:8px>";d.summary.keywords.forEach(function(k){h+="<span class=badge>#"+esc(k)+"</span>"});h+="</div>"}\n' +
'    h+="</div>"}\n' +
'  h+="<div class=box><h2>음성 기록</h2>";\n' +
'  (d.segments||[]).forEach(function(s){\n' +
'    var nm=(d.speakers&&d.speakers[s.speaker]&&d.speakers[s.speaker].name)||("참석"+String.fromCharCode(65+((s.speaker||0)%26)));\n' +
'    var mA=/^참석([A-Z]{1,2})$/.exec(nm),mN=/^참석자\\s?(\\d+)$/.exec(nm),av=mA?mA[1]:(mN?mN[1]:nm.slice(0,2));\n' +
'    h+="<div class=seg><div class=sp style=\\"background:"+COLORS[(s.speaker||0)%COLORS.length]+"\\">"+esc(av)+"</div>"+\n' +
'      "<div><div class=t>"+esc(nm)+" · "+fmt(s.start)+"</div><div"+(s.highlighted?" class=hl":"")+">"+esc(s.text)+"</div></div></div>";\n' +
'  });\n' +
'  h+="</div>";\n' +
'  if(d.memos&&d.memos.length){h+="<div class=box><h2>메모</h2>";d.memos.forEach(function(m){h+="<div class=seg><div><div class=t>"+fmt(m.time)+"</div><div>"+esc(m.text)+"</div></div></div>"});h+="</div>"}\n' +
'  el.innerHTML=h;\n' +
'}\n' +
'function b64buf(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a.buffer}\n' +
'if(typeof VN_ENC!=="undefined"){\n' +
'  document.getElementById("root").innerHTML="<div id=pw><h1>보호된 노트</h1><p>이 노트는 비밀번호로 암호화되어 있습니다.</p>"+\n' +
'    "<input type=password id=pwi placeholder=\\"비밀번호 입력\\"><br><button id=pwb>열기</button><div class=err id=pwe></div></div>";\n' +
'  var tryOpen=function(){\n' +
'    var pw=document.getElementById("pwi").value;\n' +
'    var enc=new TextEncoder();\n' +
'    crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveKey"]).then(function(bk){\n' +
'      return crypto.subtle.deriveKey({name:"PBKDF2",salt:b64buf(VN_ENC.salt),iterations:150000,hash:"SHA-256"},bk,{name:"AES-GCM",length:256},false,["decrypt"])\n' +
'    }).then(function(key){\n' +
'      return crypto.subtle.decrypt({name:"AES-GCM",iv:b64buf(VN_ENC.iv)},key,b64buf(VN_ENC.data))\n' +
'    }).then(function(buf){\n' +
'      render(JSON.parse(new TextDecoder().decode(buf)))\n' +
'    }).catch(function(){document.getElementById("pwe").textContent="비밀번호가 올바르지 않습니다."})\n' +
'  };\n' +
'  document.getElementById("pwb").addEventListener("click",tryOpen);\n' +
'  document.getElementById("pwi").addEventListener("keydown",function(e){if(e.key==="Enter")tryOpen()});\n' +
'}else{render(VN_DATA)}\n' +
'<\/script></body></html>';
  }

  /* ── 전체 백업 다운로드 ── */
  async function downloadBackup(includeAudio) {
    const data = await VN.db.backup(includeAudio);
    const name = 'voicenote-backup-' + VN.util.fmtDateShort(Date.now()) + '.json';
    download(name, JSON.stringify(data), 'application/json;charset=utf-8');
    return name;
  }

  return { toTXT, toDOC, toSRT, toVTT, toJSON, toShareHTML, download, downloadBackup, safeName, srtTime, vttTime };
})();
