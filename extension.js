const vscode = require('vscode');
const { AIAnalyzer } = require('./src/analyzer');
const { DiagnosticsManager, AICodeActionProvider } = require('./src/diagnostics');
const { SidebarProvider } = require('./src/sidebar');
const { GitManager } = require('./src/git');

// ✅ Hash pour le cache — même code = même clé
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

let lastAnalysisResult = null;
let lastAnalysisFile = null;
let currentAbortController = null;

function activate(context) {
  console.log('[INFO] Extension activated!');

  const config = vscode.workspace.getConfiguration('aiAssistant');
  const apiKey = config.get('apiKey') || '';
  const language = config.get('language') || 'fr';

  const analyzer = new AIAnalyzer(apiKey, language);
  const diagnosticsManager = new DiagnosticsManager();
  const sidebarProvider = new SidebarProvider(context, analyzer, diagnosticsManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiAssistant.sidebarView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const supportedLanguages = ['javascript', 'typescript', 'python', 'java', 'cpp', 'c', 'go', 'rust', 'php', 'ruby'];
  const codeActionProvider = new AICodeActionProvider(diagnosticsManager);
  supportedLanguages.forEach(function(lang) {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        { language: lang }, codeActionProvider,
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
      )
    );
  });

  // Auto-completion
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      supportedLanguages.map(function(l) { return { language: l }; }),
      {
        provideInlineCompletionItems: async function(document, position) {
          const cfg = vscode.workspace.getConfiguration('aiAssistant');
          if (!cfg.get('autoComplete') || !cfg.get('apiKey')) return [];
          try {
            analyzer.apiKey = cfg.get('apiKey');
            const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const suffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));
            const result = await analyzer.getCompletion(prefix, suffix, document.languageId);
            if (!result.refactored) return [];
            return [{ insertText: result.refactored, range: new vscode.Range(position, position) }];
          } catch (e) { return []; }
        }
      }
    )
  );

  // ── Analyser le fichier (avec Stop + cache)
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeFile', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      const key = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
      if (!key) {
        const action = await vscode.window.showErrorMessage('Clé API manquante !', 'Configurer');
        if (action) vscode.commands.executeCommand('aiAssistant.setApiKey');
        return;
      }

      if (currentAbortController) { currentAbortController.abort(); }
      currentAbortController = { aborted: false, abort: function() { this.aborted = true; } };
      var localController = currentAbortController;

      var fileKey = editor.document.uri.toString() + '_' + editor.document.getText().length + '_' + editor.document.languageId;

      // Cache : même fichier, même contenu = même résultat
      if (lastAnalysisFile === fileKey && lastAnalysisResult) {
        sidebarProvider.sendAnalysisResult(lastAnalysisResult, 'analyze');
        vscode.window.showInformationMessage('Résultat depuis le cache.');
        return;
      }

      sidebarProvider.sendStatus('analyzing');

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'AI: Analyse en cours...',
        cancellable: true
      }, async function(progress, token) {
        token.onCancellationRequested(function() {
          localController.abort();
          sidebarProvider.sendStatus('idle');
        });
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var result = await analyzer.analyzeFile(editor.document.getText(), editor.document.languageId);
          if (localController.aborted) return;
          result._mode = 'analyze';
          lastAnalysisResult = result;
          lastAnalysisFile = fileKey;
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'analyze');
          sidebarProvider.sendStatus('idle');
          var e = result.errors ? result.errors.filter(function(x) { return x.severity === 'error'; }).length : 0;
          var w = result.errors ? result.errors.filter(function(x) { return x.severity === 'warning'; }).length : 0;
          var score = result.score || 0;
          var medal = score>=95?'🏆':score>=85?'✅':score>=70?'⚠️':score>=50?'🔶':'❌';
          if (e===0 && w===0) vscode.window.showInformationMessage(medal + ' Code parfait ! Score: ' + score + '/100');
          else vscode.window.showWarningMessage(medal + ' ' + e + ' erreur(s), ' + w + ' warning(s) — Score: ' + score + '/100', 'Relancer ▶️').then(function(action) {
            if (action === 'Relancer ▶️') {
              lastAnalysisFile = null; // Invalider le cache
              vscode.commands.executeCommand('aiAssistant.analyzeFile');
            }
          });
        } catch (err) {
          if (!localController.aborted) {
            sidebarProvider.sendStatus('idle');
            vscode.window.showErrorMessage('Erreur: ' + err.message);
          }
        }
      });
    })
  );

  // ── Stop
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.stopAnalysis', function() {
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        sidebarProvider.sendStatus('idle');
        vscode.window.showInformationMessage('Analyse arrêtée.');
      }
    })
  );

  // ── Analyse sécurité
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeSecurity', async function() {
      var editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyse sécurité...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var result = await analyzer.analyzeSecurity(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          result._mode = 'security'; lastAnalysisResult = result;
          lastAnalysisFile = editor.document.uri.toString() + '_security';
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'security');
          sidebarProvider.sendStatus('idle');
          var vulns = result.errors ? result.errors.filter(function(x){return x.severity==='error';}).length : 0;
          if (vulns===0) vscode.window.showInformationMessage('✅ Aucune vulnérabilité critique !');
          else vscode.window.showWarningMessage('⚠️ ' + vulns + ' vulnérabilité(s) critique(s) !');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Analyse Performance
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzePerformance', async function() {
      var editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '⚡ Analyse performance...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var result = await analyzer.analyzePerformance(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          result._mode = 'performance';
          lastAnalysisResult = result;
          lastAnalysisFile = editor.document.uri.toString() + '_performance';
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'performance');
          sidebarProvider.sendStatus('idle');
          var e = result.errors ? result.errors.filter(function(x){return x.severity==='error';}).length : 0;
          var w = result.errors ? result.errors.filter(function(x){return x.severity==='warning';}).length : 0;
          var score = result.score || 0;
          var medal = score>=95?'🚀':score>=80?'⚡':score>=65?'⚠️':score>=50?'🔴':'💥';
          if (e===0 && w===0) vscode.window.showInformationMessage(medal + ' Performance optimale ! Score: ' + score + '/100');
          else vscode.window.showWarningMessage(medal + ' ' + e + ' problème(s) perf, ' + w + ' avertissement(s) — Score: ' + score + '/100');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Générer documentation
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.generateDoc', async function() {
      var editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Génération documentation...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var result = await analyzer.generateDocumentation(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          sidebarProvider.sendStatus('idle');
          if (result.refactored) {
            var action = await vscode.window.showInformationMessage('Documentation générée !', 'Remplacer le fichier', 'Voir dans sidebar');
            if (action === 'Remplacer le fichier') {
              await editor.edit(function(b) { b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), result.refactored); });
            }
          }
          sidebarProvider.sendAnalysisResult(result, 'doc');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Analyser projet
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeProject', async function() {
      var workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) { vscode.window.showWarningMessage('Ouvrez un dossier projet !'); return; }
      var editor = vscode.window.activeTextEditor;
      var mainLanguage = editor ? editor.document.languageId : 'java';
      var extMap = { java: ['java'], javascript: ['js'], typescript: ['ts'], python: ['py'] };
      var extensions = extMap[mainLanguage] || ['java', 'js', 'ts', 'py'];
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyse du projet...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var gitManager = new GitManager(workspaceFolders[0].uri.fsPath);
          var filesMap = gitManager.getProjectFiles(extensions, 8);
          if (Object.keys(filesMap).length === 0) { sidebarProvider.sendStatus('idle'); vscode.window.showWarningMessage('Aucun fichier trouvé.'); return; }
          var result = await analyzer.analyzeProject(filesMap, mainLanguage);
          if (token.isCancellationRequested) return;
          result._mode = 'project'; lastAnalysisResult = result;
          lastAnalysisFile = 'project_' + workspaceFolders[0].uri.toString();
          sidebarProvider.sendAnalysisResult(result, 'project');
          sidebarProvider.sendStatus('idle');
          vscode.window.showInformationMessage('✅ Analyse projet — ' + Object.keys(filesMap).length + ' fichiers');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Analyser Git diff
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeGit', async function() {
      var workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) { vscode.window.showWarningMessage('Ouvrez un dossier projet !'); return; }
      var gitManager = new GitManager(workspaceFolders[0].uri.fsPath);
      if (!gitManager.isGitRepo()) { vscode.window.showWarningMessage('Pas un dépôt Git !'); return; }
      var choice = await vscode.window.showQuickPick(
        ['Changements non stagés (git diff)', 'Changements stagés (git diff --cached)', 'Dernier commit (HEAD~1)'],
        { placeHolder: 'Quel diff analyser ?' }
      );
      if (!choice) return;
      var diff = choice.includes('non stagés') ? gitManager.getUnstagedDiff() : choice.includes('stagés') ? gitManager.getStagedDiff() : gitManager.getLastCommitDiff();
      if (!diff || diff.trim().length === 0) { vscode.window.showInformationMessage('Aucun changement Git trouvé.'); return; }
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyse Git diff...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var editor = vscode.window.activeTextEditor;
          var result = await analyzer.analyzeGitDiff(diff, editor ? editor.document.languageId : 'text');
          if (token.isCancellationRequested) return;
          sidebarProvider.sendAnalysisResult(result, 'git');
          sidebarProvider.sendGitStatus(gitManager.getStatus());
          sidebarProvider.sendStatus('idle');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Générer code
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.generateCode', async function() {
      var editor = vscode.window.activeTextEditor;
      var lang = editor ? editor.document.languageId : 'javascript';
      var description = await vscode.window.showInputBox({ prompt: 'Décris le code à générer', placeHolder: 'Ex: Une fonction qui valide un email' });
      if (!description) return;
      sidebarProvider.sendStatus('analyzing');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Génération...', cancellable: true }, async function(progress, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          var ctx = editor ? editor.document.getText().substring(0, 1000) : '';
          var result = await analyzer.generateCode(description, lang, ctx);
          if (token.isCancellationRequested) return;
          sidebarProvider.sendStatus('idle');
          if (result.refactored) {
            var action = await vscode.window.showInformationMessage('Code généré !', 'Insérer', 'Voir dans sidebar');
            if (action === 'Insérer' && editor) await editor.edit(function(b) { b.insert(editor.selection.active, result.refactored); });
          }
          sidebarProvider.sendAnalysisResult(result, 'generate');
        } catch (err) { sidebarProvider.sendStatus('idle'); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── Expliquer code
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.explainCode', async function() {
      var editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage('Sélectionnez du code !'); return; }
      var out = vscode.window.createOutputChannel('AI - Explication');
      out.show(); out.appendLine('Explication en cours...\n');
      try {
        analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
        var result = await analyzer.explainCode(editor.document.getText(editor.selection), editor.document.languageId);
        out.appendLine(result.summary || result.rawText || 'Pas de réponse.');
      } catch (err) { out.appendLine('Erreur: ' + err.message); }
    })
  );

  // ── Refactorer
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.refactorCode', async function() {
      var editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage('Sélectionnez du code !'); return; }
      try {
        analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
        var result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refactoring...', cancellable: false },
          function() { return analyzer.refactorCode(editor.document.getText(editor.selection), editor.document.languageId); });
        if (result.refactored) {
          var action = await vscode.window.showInformationMessage('Refactoring prêt !', 'Remplacer');
          if (action) await editor.edit(function(b) { b.replace(editor.selection, result.refactored); });
        }
      } catch (err) { vscode.window.showErrorMessage('Erreur: ' + err.message); }
    })
  );

  // ── Configurer clé API
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.setApiKey', async function() {
      var key = await vscode.window.showInputBox({ prompt: 'Clé API Gemini (aistudio.google.com)', placeHolder: 'AIza...', password: true });
      if (key) {
        await vscode.workspace.getConfiguration('aiAssistant').update('apiKey', key, vscode.ConfigurationTarget.Global);
        analyzer.apiKey = key;
        vscode.window.showInformationMessage('✅ Clé API sauvegardée !');
      }
    })
  );

  // ── Appliquer correction
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.applyFix', async function(document, range, fixText) {
      var editor = vscode.window.visibleTextEditors.find(function(e) { return e.document.uri.toString() === document.uri.toString(); });
      if (editor) { await editor.edit(function(b) { b.replace(range, fixText); }); vscode.window.showInformationMessage('✅ Correction appliquée !'); }
    })
  );

  // ── Afficher explication
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.showExplanation', function(explanation) {
      vscode.window.showInformationMessage(explanation || "Pas d'explication.", { modal: true });
    })
  );

 // ── Auto-analyse à la sauvegarde avec bouton STOP
let autoAnalysisController = null;

context.subscriptions.push(
  vscode.workspace.onDidSaveTextDocument(async function(doc) {
    var cfg = vscode.workspace.getConfiguration('aiAssistant');
    if (!cfg.get('autoAnalyze') || !cfg.get('apiKey')) return;
    var editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;

    // Annuler l'analyse précédente si elle tourne encore
    if (autoAnalysisController) {
      autoAnalysisController.aborted = true;
    }
    autoAnalysisController = { aborted: false };
    var localController = autoAnalysisController;

    // Vérifier le cache — même code = pas de re-analyse
    var fileKey = doc.uri.toString() + '_' + simpleHash(doc.getText());
    if (lastAnalysisFile === fileKey && lastAnalysisResult) {
      return; // Même code, pas besoin de re-analyser
    }

    sidebarProvider.sendStatus('analyzing');

    // Toast avec bouton STOP
    var stopPromise = vscode.window.showInformationMessage(
      '⏳ Analyse IA en cours...', 
      'Stop ❌'
    );

    stopPromise.then(function(action) {
      if (action === 'Stop ❌') {
        localController.aborted = true;
        sidebarProvider.sendStatus('idle');
        vscode.window.showInformationMessage('🛑 Analyse arrêtée.');
      }
    });

    try {
      analyzer.apiKey = cfg.get('apiKey');
      var result = await analyzer.analyzeFile(doc.getText(), doc.languageId);

      if (localController.aborted) return;

      result._mode = 'analyze';
      lastAnalysisResult = result;
      lastAnalysisFile = fileKey;
      diagnosticsManager.updateDiagnostics(doc, result.errors);
      sidebarProvider.sendAnalysisResult(result, 'analyze');
      sidebarProvider.sendStatus('idle');

      // Résultat dans le toast
      var e = result.errors ? result.errors.filter(function(x) { return x.severity === 'error'; }).length : 0;
      var w = result.errors ? result.errors.filter(function(x) { return x.severity === 'warning'; }).length : 0;
      var score = result.score || 0;
      var medal = score>=95?'🏆':score>=85?'✅':score>=70?'⚠️':score>=50?'🔶':'❌';

      if (e === 0 && w === 0) {
        vscode.window.showInformationMessage(medal + ' Score: ' + score + '/100 — Aucun problème !');
      } else {
        vscode.window.showWarningMessage(medal + ' Score: ' + score + '/100 — ' + e + ' erreur(s), ' + w + ' warning(s)');
      }
    } catch (err) {
      if (!localController.aborted) {
        sidebarProvider.sendStatus('idle');
        console.error('Auto-analyse:', err.message);
      }
    }
  })
);
  // ── Restaure résultat quand on change de fichier
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(function(editor) {
      if (!editor) return;
      var fileKey = editor.document.uri.toString() + '_' + editor.document.getText().length + '_' + editor.document.languageId;
      if (lastAnalysisFile === fileKey && lastAnalysisResult) {
        sidebarProvider.sendAnalysisResult(lastAnalysisResult, lastAnalysisResult._mode || 'analyze');
      }
    })
  );
}

function deactivate() {}
module.exports = { activate, deactivate };