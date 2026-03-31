const vscode = require('vscode');
const path = require('path');

class SidebarProvider {
  constructor(context, analyzer, diagnosticsManager) {
    this.context = context;
    this.analyzer = analyzer;
    this.diagnosticsManager = diagnosticsManager;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this._getWebviewContent();
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this._handleMessage(message, webviewView.webview);
    });
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && this._view) {
        this._view.webview.postMessage({
          type: 'fileChanged',
          fileName: path.basename(editor.document.fileName),
          language: editor.document.languageId
        });
      }
    });
  }

  async _handleMessage(message, webview) {
    const editor = vscode.window.activeTextEditor;
    const code = editor?.document.getText() || '';
    const language = editor?.document.languageId || 'text';
    const filePath = editor?.document.fileName || '';

    switch (message.type) {
      case 'chatMessage': {
        try {
          webview.postMessage({ type: 'thinking', text: 'L\'IA réfléchit...' });
          const response = await this.analyzer.chat(message.text, code, language, filePath);
          const reply = response.summary || response.rawText || 'Pas de réponse.';
          webview.postMessage({ type: 'chatResponse', text: reply });
        } catch (err) {
          webview.postMessage({ type: 'error', text: 'Erreur: ' + err.message });
        }
        break;
      }
      case 'analyzeFile': {
        if (!editor) { webview.postMessage({ type: 'error', text: 'Aucun fichier ouvert.' }); break; }
        try {
          webview.postMessage({ type: 'thinking', text: 'Analyse en cours...' });
          const result = await this.analyzer.analyzeFile(code, language);
          this.diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          webview.postMessage({ type: 'analysisResult', errors: result.errors || [], summary: result.summary, score: result.score, scoreDetails: result.scoreDetails, advice: result.advice || [], mode: 'analyze' });
        } catch (err) {
          webview.postMessage({ type: 'error', text: 'Erreur: ' + err.message });
        }
        break;
      }
      case 'clearChat': {
        this.analyzer.clearHistory();
        webview.postMessage({ type: 'chatCleared' });
        break;
      }
      case 'setApiKey': {
        vscode.commands.executeCommand('aiAssistant.setApiKey');
        break;
      }
    }
  }

  sendAnalysisResult(result, mode) {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'analysisResult',
        errors: result.errors || [],
        summary: result.summary,
        score: result.score,
        scoreDetails: result.scoreDetails,
        advice: result.advice || [],
        mode: mode || 'analyze'
      });
    }
  }
sendAnalyzingState(isAnalyzing) {
  this.sendStatus(isAnalyzing ? 'analyzing' : 'idle');
}

sendStatus(status) {
  if (this._view) {
    this._view.webview.postMessage({
      type: 'statusUpdate',
      status: status
    });
  }
}
  sendGitStatus(status) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'gitStatus', status: status });
    }
  }

  _getWebviewContent() {
    const html = '<!DOCTYPE html>\n' +
      '<html lang="fr">\n' +
      '<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">\n' +
      '<title>AI Assistant Pro</title>\n' +
      '<style>\n' +
      ':root{--bg:var(--vscode-sideBar-background);--fg:var(--vscode-sideBar-foreground);--input-bg:var(--vscode-input-background);--input-fg:var(--vscode-input-foreground);--btn-bg:var(--vscode-button-background);--btn-fg:var(--vscode-button-foreground);--border:var(--vscode-panel-border);--error:var(--vscode-editorError-foreground,#f44336);--warning:var(--vscode-editorWarning-foreground,#ff9800);--info:var(--vscode-editorInfo-foreground,#2196f3);--success:#4caf50;}\n' +
      '*{box-sizing:border-box;margin:0;padding:0;}\n' +
      'body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--fg);background:var(--bg);display:flex;flex-direction:column;height:100vh;overflow:hidden;}\n' +
      '.header{padding:8px 12px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;}\n' +
      '.header h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;}\n' +
      '.file-badge{font-size:10px;padding:2px 6px;border-radius:10px;background:var(--btn-bg);color:var(--btn-fg);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n' +
      '.actions{padding:6px 12px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--border);}\n' +
      '.btn{padding:4px 10px;background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:3px;cursor:pointer;font-size:11px;text-align:left;}\n' +
      '.btn:hover{opacity:0.85;}\n' +
      '.messages{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:8px;}\n' +
      '.message{border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;}\n' +
      '.message.user{background:var(--btn-bg);color:var(--btn-fg);align-self:flex-end;max-width:85%;}\n' +
      '.message.bot{background:var(--input-bg);border:1px solid var(--border);}\n' +
      '.message.thinking{color:#888;font-style:italic;}\n' +
      '.message.error{background:rgba(244,67,54,0.1);border:1px solid var(--error);color:var(--error);}\n' +
      '.message.bot strong{font-weight:700;}\n' +
      '.message.bot em{font-style:italic;color:#aaa;}\n' +
      '.message.bot ul{margin:4px 0 4px 16px;}\n' +
      '.message.bot li{margin:2px 0;}\n' +
      '.message.bot code{background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-family:monospace;font-size:11px;}\n' +
      '.score-section{margin:8px 0;}\n' +
      '.score-main{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;margin-bottom:6px;}\n' +
      '.score-circle{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0;}\n' +
      '.score-info{flex:1;}\n' +
      '.score-label{font-size:13px;font-weight:600;margin-bottom:2px;}\n' +
      '.score-sublabel{font-size:10px;opacity:0.7;}\n' +
      '.score-breakdown{margin:6px 0;}\n' +
      '.breakdown-row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.05);}\n' +
      '.breakdown-row:last-child{border-bottom:none;}\n' +
      '.breakdown-name{flex:1;opacity:0.85;}\n' +
      '.breakdown-bar{width:60px;height:5px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;}\n' +
      '.breakdown-fill{height:100%;border-radius:3px;transition:width 0.5s;}\n' +
      '.breakdown-pts{font-size:10px;min-width:40px;text-align:right;}\n' +
      '.breakdown-detail{font-size:10px;opacity:0.6;width:100%;padding-left:0;margin-top:1px;}\n' +
      '.advice-section{margin-top:8px;}\n' +
      '.advice-title{font-size:11px;font-weight:600;margin-bottom:4px;opacity:0.8;}\n' +
      '.advice-item{display:flex;gap:6px;padding:4px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.05);align-items:flex-start;}\n' +
      '.advice-item:last-child{border-bottom:none;}\n' +
      '.advice-num{font-size:10px;background:var(--btn-bg);color:var(--btn-fg);border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}\n' +
      '.error-card{border-radius:4px;padding:5px 8px;margin:2px 0;font-size:11px;border-left:3px solid;}\n' +
      '.error-card.error{border-color:var(--error);background:rgba(244,67,54,0.08);}\n' +
      '.error-card.warning{border-color:var(--warning);background:rgba(255,152,0,0.08);}\n' +
      '.error-card.info{border-color:var(--info);background:rgba(33,150,243,0.08);}\n' +
      '.error-card .line{font-size:10px;color:#888;margin-bottom:2px;}\n' +
      '.error-card .msg{font-weight:500;}\n' +
      '.error-card .fix{margin-top:3px;color:#aaa;font-style:italic;font-size:10px;}\n' +
      '.input-area{padding:8px 12px;border-top:1px solid var(--border);display:flex;gap:6px;}\n' +
      '.input-area input{flex:1;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--border);border-radius:3px;padding:5px 8px;font-size:12px;outline:none;}\n' +
      '.input-area input:focus{border-color:var(--btn-bg);}\n' +
      '.send-btn{background:var(--btn-bg);color:var(--btn-fg);border:none;border-radius:3px;padding:5px 10px;cursor:pointer;font-size:14px;}\n' +
      '</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<div class="header"><h3>AI Assistant Pro</h3><span class="file-badge" id="fileBadge">Aucun fichier</span></div>\n' +
      '<div class="actions">\n' +
      '<button class="btn" onclick="send(\'analyzeFile\')">Analyser le fichier</button>\n' +
      '<button class="btn" onclick="clearChat()">Effacer la conversation</button>\n' +
      '<button class="btn" onclick="send(\'setApiKey\')">Configurer la clé API</button>\n' +
      '</div>\n' +
      '<div class="messages" id="messages">\n' +
      '<div class="message bot">Bonjour ! Ouvrez un fichier et cliquez sur <b>Analyser</b>, ou posez-moi une question.</div>\n' +
      '</div>\n' +
      '<div class="input-area">\n' +
      '<input type="text" id="chatInput" placeholder="Posez une question..." onkeydown="if(event.key===\'Enter\') sendChat()"/>\n' +
      '<button class="send-btn" onclick="sendChat()">&#9658;</button>\n' +
      '</div>\n' +
      '<script>\n' +
      'var vscode = acquireVsCodeApi();\n' +
      'function send(type, data) { vscode.postMessage(Object.assign({ type: type }, data || {})); }\n' +
      'function sendChat() {\n' +
      '  var input = document.getElementById("chatInput");\n' +
      '  var text = input.value.trim();\n' +
      '  if (!text) return;\n' +
      '  addMessage(text, "user");\n' +
      '  input.value = "";\n' +
      '  send("chatMessage", { text: text });\n' +
      '}\n' +
      'function clearChat() { send("clearChat"); }\n' +
      'function parseMarkdown(text) {\n' +
      '  return text\n' +
      '    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")\n' +
      '    .replace(/\\*(.+?)\\*/g, "<em>$1</em>")\n' +
      '    .replace(/#{3} (.+)/g, "<h3 style=\'font-size:12px;margin:6px 0 2px\'>$1</h3>")\n' +
      '    .replace(/#{2} (.+)/g, "<h2 style=\'font-size:13px;margin:6px 0 2px\'>$1</h2>")\n' +
      '    .replace(/# (.+)/g, "<h1 style=\'font-size:13px;margin:6px 0 2px\'>$1</h1>")\n' +
      '    .replace(new RegExp("`(.+?)`", "g"), "<code>$1</code>")\n' +
      '    .replace(/^\\* (.+)/gm, "<li>$1</li>")\n' +
      '    .replace(/^\\d+\\. (.+)/gm, "<li>$1</li>")\n' +
      '    .replace(/(<li>.*<\\/li>)/gs, "<ul>$1</ul>")\n' +
      '    .replace(/\\n\\n/g, "<br><br>")\n' +
      '    .replace(/\\n/g, "<br>");\n' +
      '}\n' +
      'function addMessage(content, type, isHTML) {\n' +
      '  var messages = document.getElementById("messages");\n' +
      '  var thinking = messages.querySelector(".thinking");\n' +
      '  if (thinking && type !== "user") thinking.remove();\n' +
      '  var div = document.createElement("div");\n' +
      '  div.className = "message " + type;\n' +
      '  if (isHTML) div.innerHTML = content;\n' +
      '  else if (type === "bot") div.innerHTML = parseMarkdown(content);\n' +
      '  else div.textContent = content;\n' +
      '  messages.appendChild(div);\n' +
      '  messages.scrollTop = messages.scrollHeight;\n' +
      '}\n' +
      'function getScoreColor(score) {\n' +
      '  if (score >= 95) return "#4caf50";\n' +
      '  if (score >= 85) return "#8bc34a";\n' +
      '  if (score >= 70) return "#ff9800";\n' +
      '  if (score >= 50) return "#ff5722";\n' +
      '  return "#f44336";\n' +
      '}\n' +
      'function getScoreLabel(score) {\n' +
      '  if (score >= 95) return "Expert — niveau FAANG";\n' +
      '  if (score >= 85) return "Professionnel — dev senior";\n' +
      '  if (score >= 70) return "Correct — dev mid-level";\n' +
      '  if (score >= 50) return "Acceptable — dev junior";\n' +
      '  if (score >= 30) return "Problematique — refactoring requis";\n' +
      '  return "Critique — réécriture recommandée";\n' +
      '}\n' +
      'function getScoreMedal(score) {\n' +
      '  if (score >= 95) return "🏆";\n' +
      '  if (score >= 85) return "✅";\n' +
      '  if (score >= 70) return "⚠️";\n' +
      '  if (score >= 50) return "🔶";\n' +
      '  return "❌";\n' +
      '}\n' +
     'window.addEventListener("message", function(event) {\n' +
     '  var msg = event.data;\n' +
     '  switch (msg.type) {\n' +
     '    case "thinking": addMessage(msg.text, "thinking"); break;\n' +
     '    case "chatResponse": addMessage(msg.text, "bot"); break;\n' +
     '    case "error": addMessage(msg.text, "error"); break;\n' +
     '    case "chatCleared": document.getElementById("messages").innerHTML = "<div class=\'message bot\'>Conversation effacée !</div>"; break;\n' +
     '    case "fileChanged": document.getElementById("fileBadge").textContent = msg.fileName || "Aucun"; break;\n' +
     '    case "statusUpdate": var badge = document.getElementById("fileBadge"); if (msg.status === "analyzing") { badge.textContent = "⏳ Analyse..."; badge.style.background = "#ff9800"; } else { badge.style.background = ""; } break;\n' +
     '    case "analysisResult": renderResult(msg); break;\n' +
     '  }\n' +
     '});\n' +
      'function renderResult(msg) {\n' +
      '  var errors = msg.errors || [];\n' +
      '  var summary = msg.summary || "";\n' +
      '  var score = msg.score;\n' +
      '  var scoreDetails = msg.scoreDetails;\n' +
      '  var advice = msg.advice || [];\n' +
      '  var html = "";\n' +
      '  if (score !== null && score !== undefined) {\n' +
      '    var color = getScoreColor(score);\n' +
      '    var label = getScoreLabel(score);\n' +
      '    var medal = getScoreMedal(score);\n' +
      '    html += "<div class=\'score-section\'>";\n' +
      '    html += "<div class=\'score-main\' style=\'background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)\'>";\n' +
      '    html += "<div class=\'score-circle\' style=\'background:" + color + "22;border:2px solid " + color + ";color:" + color + "\'>" + score + "</div>";\n' +
      '    html += "<div class=\'score-info\'><div class=\'score-label\' style=\'color:" + color + "\'>" + medal + " " + label + "</div>";\n' +
      '    html += "<div class=\'score-sublabel\'>" + errors.filter(function(e){return e.severity==="error";}).length + " erreur(s) · " + errors.filter(function(e){return e.severity==="warning";}).length + " warning(s)</div></div></div>";\n' +
      '    if (scoreDetails && scoreDetails.breakdown && scoreDetails.breakdown.length > 0) {\n' +
      '      html += "<div class=\'score-breakdown\'>";\n' +
      '      scoreDetails.breakdown.forEach(function(b) {\n' +
      '        var pct = Math.round((b.note / b.max) * 100);\n' +
      '        var bcolor = pct >= 90 ? "#4caf50" : pct >= 70 ? "#ff9800" : "#f44336";\n' +
      '        html += "<div class=\'breakdown-row\'>";\n' +
      '        html += "<span class=\'breakdown-name\'>" + b.critere + "</span>";\n' +
      '        html += "<div class=\'breakdown-bar\'><div class=\'breakdown-fill\' style=\'width:" + pct + "%;background:" + bcolor + "\'></div></div>";\n' +
      '        html += "<span class=\'breakdown-pts\' style=\'color:" + bcolor + "\'>" + b.note + "/" + b.max + "</span>";\n' +
      '        html += "</div>";\n' +
      '        if (b.detail && b.detail !== "RAS") {\n' +
      '          html += "<div class=\'breakdown-detail\'>→ " + b.detail + "</div>";\n' +
      '        }\n' +
      '      });\n' +
      '      html += "</div>";\n' +
      '    }\n' +
      '    html += "</div>";\n' +
      '  }\n' +
      '  if (summary) html += "<p style=\'font-size:11px;opacity:0.75;margin:6px 0;\'>" + parseMarkdown(summary) + "</p>";\n' +
      '  if (errors.length > 0) {\n' +
      '    html += "<b style=\'font-size:11px;\'>" + errors.length + " problème(s) détecté(s):</b>";\n' +
      '    errors.forEach(function(e) {\n' +
      '      html += "<div class=\'error-card " + (e.severity || "warning") + "\'>";\n' +
      '      html += "<div class=\'line\'>" + (e.line ? "Ligne " + e.line : "Global") + "</div>";\n' +
      '      html += "<div class=\'msg\'>" + e.message + "</div>";\n' +
      '      if (e.fix) html += "<div class=\'fix\'>Correction: " + e.fix + "</div>";\n' +
      '      html += "</div>";\n' +
      '    });\n' +
      '  }\n' +
      '  if (advice && advice.length > 0) {\n' +
      '    html += "<div class=\'advice-section\'><div class=\'advice-title\'>Conseils pour améliorer:</div>";\n' +
      '    advice.forEach(function(a, i) {\n' +
      '      html += "<div class=\'advice-item\'><span class=\'advice-num\'>" + (i+1) + "</span><span>" + a + "</span></div>";\n' +
      '    });\n' +
      '    html += "</div>";\n' +
      '  }\n' +
      '  addMessage(html, "bot", true);\n' +
      '}\n' +
      '</script>\n' +
      '</body>\n' +
      '</html>';
    return html;
  }
}

module.exports = { SidebarProvider };