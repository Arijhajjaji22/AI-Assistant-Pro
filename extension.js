const vscode = require('vscode');
const path = require('path');
const { AIAnalyzer } = require('./src/analyzer');
const { DiagnosticsManager, AICodeActionProvider } = require('./src/diagnostics');
const { SidebarProvider } = require('./src/sidebar');
const { GitManager } = require('./src/git');
const { AnalysisPipeline } = require('./src/pipeline');

const SUPPORTED_LANGUAGES = [
  'javascript', 'typescript', 'python', 'java', 'cpp', 'c',
  'go', 'rust', 'php', 'ruby', 'html', 'css', 'sql', 'yaml', 'shellscript'
];

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return h.toString(36);
}

let lastAnalysisResult = null;
let lastAnalysisFile = null;
let currentAbortController = null;

function activate(context) {
  console.log('[AI Assistant] Activated');

  const config = vscode.workspace.getConfiguration('aiAssistant');
  const analyzer = new AIAnalyzer(config.get('apiKey') || '', config.get('language') || 'fr');
  const diagnosticsManager = new DiagnosticsManager();
  const sidebarProvider = new SidebarProvider(context, analyzer, diagnosticsManager);

  // ── Sidebar (retainContext = résultats persistent quand sidebar cachée)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aiAssistant.sidebarView', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ── Code Actions (ampoule 💡) — apparaît AUTOMATIQUEMENT sur chaque diagnostic
  // VS Code appelle provideCodeActions dès que le curseur est sur une ligne avec un diagnostic
  const codeActionProvider = new AICodeActionProvider(diagnosticsManager, analyzer);
  SUPPORTED_LANGUAGES.forEach(function(lang) {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        { language: lang },
        codeActionProvider,
        {
          providedCodeActionKinds: [
            vscode.CodeActionKind.QuickFix,
            vscode.CodeActionKind.RefactorRewrite
          ]
        }
      )
    );
  });

  // ── Status Bar — score permanent en bas
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'aiAssistant.analyzeFile';
  statusBar.tooltip = 'Cliquez pour analyser';
  statusBar.text = '$(robot) AI';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function updateStatusBar(score, isAnalyzing) {
    if (isAnalyzing) { statusBar.text = '$(sync~spin) AI…'; return; }
    if (score === null || score === undefined) { statusBar.text = '$(robot) AI'; statusBar.backgroundColor = undefined; return; }
    const medal = score >= 95 ? '🏆' : score >= 85 ? '✅' : score >= 70 ? '⚠️' : score >= 50 ? '🔶' : '❌';
    statusBar.text = '$(robot) ' + medal + ' ' + score;
    statusBar.backgroundColor = score < 50
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : score < 70 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  // ── COMMANDE : Analyser le fichier
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeFile', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      const key = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
      if (!key) {
        const a = await vscode.window.showErrorMessage('Clé API manquante !', 'Configurer');
        if (a) vscode.commands.executeCommand('aiAssistant.setApiKey');
        return;
      }

      if (currentAbortController) currentAbortController.abort();
      currentAbortController = { aborted: false, abort: function() { this.aborted = true; } };
      const localCtrl = currentAbortController;

      const fileKey = editor.document.uri.toString() + '_' + simpleHash(editor.document.getText()) + '_' + editor.document.languageId;
      if (lastAnalysisFile === fileKey && lastAnalysisResult) {
        sidebarProvider.sendAnalysisResult(lastAnalysisResult, lastAnalysisResult._mode || 'analyze');
        updateStatusBar(lastAnalysisResult.score);
        vscode.window.showInformationMessage('📋 Résultat depuis le cache.');
        return;
      }

      updateStatusBar(null, true);
      sidebarProvider.sendAnalyzingState(true);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '🤖 Analyse IA en cours…',
        cancellable: true
      }, async function(_, token) {
        token.onCancellationRequested(function() { localCtrl.abort(); sidebarProvider.sendAnalyzingState(false); updateStatusBar(null); });
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.analyzeFile(editor.document.getText(), editor.document.languageId);
          if (localCtrl.aborted) return;
          result._mode = 'analyze';
          lastAnalysisResult = result;
          lastAnalysisFile = fileKey;
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'analyze', path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);
          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const w = (result.errors || []).filter(x => x.severity === 'warning').length;
          const s = result.score || 0;
          const medal = s >= 95 ? '🏆' : s >= 85 ? '✅' : s >= 70 ? '⚠️' : s >= 50 ? '🔶' : '❌';
          const msg = e === 0 && w === 0 ? medal + ' Code parfait ! Score: ' + s + '/100' : medal + ' ' + e + ' erreur(s), ' + w + ' warning(s) — Score: ' + s + '/100';
          const action = e === 0 && w === 0
            ? await vscode.window.showInformationMessage(msg, 'Voir détails')
            : await vscode.window.showWarningMessage(msg, 'Voir détails', 'Relancer');
          if (action === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
          if (action === 'Relancer') { lastAnalysisFile = null; vscode.commands.executeCommand('aiAssistant.analyzeFile'); }
        } catch (err) {
          if (!localCtrl.aborted) { sidebarProvider.sendAnalyzingState(false); updateStatusBar(null); vscode.window.showErrorMessage('Erreur: ' + err.message); }
        }
      });
    })
  );

  // ── COMMANDE : Stop
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.stopAnalysis', function() {
      if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
      sidebarProvider.sendAnalyzingState(false);
      updateStatusBar(null);
      vscode.window.showInformationMessage('⏹ Analyse arrêtée.');
    })
  );

  // ══════════════════════════════════════════════════════
  //  COMMANDE : fixWithAI — le cœur du comportement Copilot
  //
  //  Appelée par l'ampoule 💡 → "🤖 Corriger avec IA"
  //  1. Récupère la méthode entière autour de l'erreur
  //  2. Envoie à Gemini avec prompt chirurgical
  //  3. Applique le résultat directement sans popup
  // ══════════════════════════════════════════════════════
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.fixWithAI', async function(document, methodRange, lineIndex, errorMessage, suggestedFix, explanation, indent) {
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
      if (!editor) return;

      const originalCode = methodRange ? document.getText(methodRange) : document.lineAt(lineIndex).text;
      const language = document.languageId;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: '🤖 AI Fix…'
      }, async function() {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');

          // Prompt chirurgical — style Copilot, pas de description, du code direct
         const prompt =
  'RÈGLE 1: Retourne UNIQUEMENT le contenu de la méthode corrigée dans "refactored", SANS la signature, SANS les accolades ouvrante/fermante.\n' +
  'RÈGLE 2: Si tu ne peux pas corriger sans casser le code, retourne le code ORIGINAL inchangé.\n' +
  'RÈGLE 3: NE PAS ajouter de code avant ou après la méthode.\n\n' +
  'PROBLÈME: ' + errorMessage + '\n' +
  'CODE:\n```' + language + '\n' + originalCode + '\n```';
// Vérifie que le fix ne contient pas de code parasite
const originalLines = originalCode.split('\n').length;
const fixedLines = fixedCode.split('\n').length;
if (fixedLines > originalLines * 2) {
  vscode.window.showWarningMessage('⚠️ Fix rejeté — trop de lignes ajoutées.');
  return;
}
          const result = await analyzer.generateCode(prompt, language, '');

          if (!result.refactored || result.refactored.trim().length < 10) {
            vscode.window.showWarningMessage('⚠️ AI Fix: pas de correction générée.');
            return;
          }

          let fixedCode = result.refactored.trim();

          // Nettoie les backticks markdown si l'IA les a ajoutés
          fixedCode = fixedCode.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

          // Applique directement — comme Copilot, sans confirmation popup
          if (methodRange) {
            await editor.edit(function(b) { b.replace(methodRange, fixedCode); });
          } else {
            await editor.edit(function(b) {
              b.replace(document.lineAt(lineIndex).range, (indent || '') + fixedCode);
            });
          }

          // Message discret en status bar (3s) — pas de popup bloquante
          vscode.window.setStatusBarMessage('✅ AI Fix appliqué — ' + (result.summary || 'correction effectuée'), 4000);

          // Re-analyse en arrière-plan pour mettre à jour les diagnostics
          setTimeout(async function() {
            try {
              const updatedText = editor.document.getText();
              const reAnalysis = await analyzer.analyzeFile(updatedText, language);
              diagnosticsManager.updateDiagnostics(editor.document, reAnalysis.errors);
              updateStatusBar(reAnalysis.score);
            } catch (_) { /* silencieux */ }
          }, 1500);

        } catch (err) {
          vscode.window.showErrorMessage('AI Fix: ' + err.message);
        }
      });
    })
  );

  // ── COMMANDE : Analyse sécurité
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeSecurity', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '🔒 Analyse sécurité…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.analyzeSecurity(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'security', path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          const v = (result.errors || []).filter(x => x.severity === 'error').length;
          const action = v === 0
            ? await vscode.window.showInformationMessage('✅ Aucune vulnérabilité critique !', 'Voir détails')
            : await vscode.window.showWarningMessage('🔒 ' + v + ' vulnérabilité(s) !', 'Voir détails');
          if (action === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Analyse performance
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzePerformance', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '⚡ Analyse performance…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.analyzePerformance(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'performance', path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);
          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const s = result.score || 0;
          const medal = s >= 95 ? '🚀' : s >= 80 ? '⚡' : s >= 65 ? '⚠️' : '🔴';
          const action = await vscode.window.showWarningMessage(medal + ' Performance: ' + s + '/100 — ' + e + ' problème(s)', 'Voir détails');
          if (action === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Détecter code mort
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeDeadCode', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '💀 Détection code mort…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.analyzeDeadCode(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'deadcode', path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          const d = (result.errors || []).length;
          const action = d === 0
            ? await vscode.window.showInformationMessage('✅ Aucun code mort !', 'Voir détails')
            : await vscode.window.showWarningMessage('💀 ' + d + ' élément(s) mort(s) !', 'Voir détails');
          if (action === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Générer documentation
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.generateDoc', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '📝 Génération doc…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.generateDocumentation(editor.document.getText(), editor.document.languageId);
          if (token.isCancellationRequested) return;
          sidebarProvider.sendAnalyzingState(false);
          if (result.refactored) {
            const a = await vscode.window.showInformationMessage('📝 Documentation générée !', 'Remplacer fichier', 'Voir sidebar');
            if (a === 'Remplacer fichier') await editor.edit(b => b.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), result.refactored));
          }
          sidebarProvider.sendAnalysisResult(result, 'doc', path.basename(editor.document.fileName), editor.document.languageId);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Analyser projet
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeProject', async function() {
      const wf = vscode.workspace.workspaceFolders;
      if (!wf) { vscode.window.showWarningMessage('Ouvrez un dossier projet !'); return; }
      const editor = vscode.window.activeTextEditor;
      const mainLang = editor ? editor.document.languageId : 'java';
      const extMap = { java: ['java'], javascript: ['js'], typescript: ['ts'], python: ['py'] };
      const exts = extMap[mainLang] || ['java', 'js', 'ts', 'py'];
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '📁 Analyse projet…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const git = new GitManager(wf[0].uri.fsPath);
          const filesMap = git.getProjectFiles(exts, 8);
          if (!Object.keys(filesMap).length) { sidebarProvider.sendAnalyzingState(false); vscode.window.showWarningMessage('Aucun fichier trouvé.'); return; }
          const result = await analyzer.analyzeProject(filesMap, mainLang);
          if (token.isCancellationRequested) return;
          sidebarProvider.sendAnalysisResult(result, 'project', 'projet', mainLang);
          sidebarProvider.sendAnalyzingState(false);
          const action = await vscode.window.showInformationMessage('📁 Analyse terminée — ' + Object.keys(filesMap).length + ' fichiers', 'Voir détails');
          if (action === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Git diff
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeGit', async function() {
      const wf = vscode.workspace.workspaceFolders;
      if (!wf) { vscode.window.showWarningMessage('Ouvrez un dossier projet !'); return; }
      const git = new GitManager(wf[0].uri.fsPath);
      if (!git.isGitRepo()) { vscode.window.showWarningMessage('Pas un dépôt Git !'); return; }
      const choice = await vscode.window.showQuickPick(
        ['Changements non stagés (git diff)', 'Changements stagés (git diff --cached)', 'Dernier commit (HEAD~1)'],
        { placeHolder: 'Quel diff analyser ?' }
      );
      if (!choice) return;
      const diff = choice.includes('non stagés') ? git.getUnstagedDiff() : choice.includes('stagés') ? git.getStagedDiff() : git.getLastCommitDiff();
      if (!diff?.trim()) { vscode.window.showInformationMessage('Aucun changement Git.'); return; }
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '🔀 Analyse Git…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const editor = vscode.window.activeTextEditor;
          const result = await analyzer.analyzeGitDiff(diff, editor?.document.languageId || 'text');
          if (token.isCancellationRequested) return;
          sidebarProvider.sendAnalysisResult(result, 'git', 'git diff', 'diff');
          sidebarProvider.sendGitStatus(git.getStatus());
          sidebarProvider.sendAnalyzingState(false);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Générer code
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.generateCode', async function() {
      const editor = vscode.window.activeTextEditor;
      const lang = editor?.document.languageId || 'javascript';
      const desc = await vscode.window.showInputBox({ prompt: 'Décris le code à générer', placeHolder: 'Ex: Valider un email avec regex' });
      if (!desc) return;
      sidebarProvider.sendAnalyzingState(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '✨ Génération…', cancellable: true }, async function(_, token) {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          const result = await analyzer.generateCode(desc, lang, editor?.document.getText().substring(0, 1000) || '');
          if (token.isCancellationRequested) return;
          sidebarProvider.sendAnalyzingState(false);
          if (result.refactored) {
            const a = await vscode.window.showInformationMessage('✨ Code généré !', 'Insérer', 'Voir sidebar');
            if (a === 'Insérer' && editor) await editor.edit(b => b.insert(editor.selection.active, result.refactored));
          }
          sidebarProvider.sendAnalysisResult(result, 'generate', path.basename(editor?.document.fileName || 'nouveau'), lang);
        } catch (err) { sidebarProvider.sendAnalyzingState(false); vscode.window.showErrorMessage('Erreur: ' + err.message); }
      });
    })
  );

  // ── COMMANDE : Expliquer sélection
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.explainCode', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage('Sélectionnez du code !'); return; }
      const out = vscode.window.createOutputChannel('AI - Explication');
      out.show(); out.appendLine('Explication en cours…\n');
      try {
        analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
        const result = await analyzer.explainCode(editor.document.getText(editor.selection), editor.document.languageId);
        out.appendLine(result.summary || result.rawText || 'Pas de réponse.');
      } catch (err) { out.appendLine('Erreur: ' + err.message); }
    })
  );

  // ── COMMANDE : Refactorer sélection
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.refactorCode', async function() {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage('Sélectionnez du code !'); return; }
      try {
        analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '♻️ Refactoring…' },
          () => analyzer.refactorCode(editor.document.getText(editor.selection), editor.document.languageId)
        );
        if (result.refactored) {
          const a = await vscode.window.showInformationMessage('♻️ Refactoring prêt !', 'Appliquer');
          if (a) await editor.edit(b => b.replace(editor.selection, result.refactored));
        }
      } catch (err) { vscode.window.showErrorMessage('Erreur: ' + err.message); }
    })
  );

  // ── COMMANDE : Configurer clé API
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.setApiKey', async function() {
      const key = await vscode.window.showInputBox({ prompt: 'Clé API Gemini (aistudio.google.com)', placeHolder: 'AIza…', password: true });
      if (key) {
        await vscode.workspace.getConfiguration('aiAssistant').update('apiKey', key, vscode.ConfigurationTarget.Global);
        analyzer.apiKey = key;
        vscode.window.showInformationMessage('🔑 Clé API sauvegardée !');
      }
    })
  );

  // ── COMMANDE : Appliquer correction (depuis ampoule classique)
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.applyFix', async function(document, range, fixText) {
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
      if (editor) {
        await editor.edit(b => b.replace(range, fixText));
        vscode.window.setStatusBarMessage('✅ Correction appliquée', 3000);
      }
    })
  );

  // ── COMMANDE : Afficher explication (modale)
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.showExplanation', function(explanation, fix) {
      const msg = explanation || 'Pas d\'explication.';
      const detail = fix ? '\n\nCorrection suggérée :\n' + fix : '';
      vscode.window.showInformationMessage(msg + detail, { modal: true });
    })
  );
  // ── COMMANDE : Analyse complète (Pipeline AST + Sécurité + IA)
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeFull', async function () {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }

      const cfg = vscode.workspace.getConfiguration('aiAssistant');
      const key = cfg.get('apiKey');
      if (!key) {
        const a = await vscode.window.showErrorMessage('Clé API manquante !', 'Configurer');
        if (a) vscode.commands.executeCommand('aiAssistant.setApiKey');
        return;
      }

      analyzer.apiKey = key;

      const wf = vscode.workspace.workspaceFolders;
      const workspacePath = wf ? wf[0].uri.fsPath : null;

      const pipeline = new AnalysisPipeline(analyzer, workspacePath, {
        useAST: cfg.get('useAST') !== false,
        useSecurity: true,
        useAI: true,
        autoFix: false,
        autoCommit: cfg.get('autoCommit') || false,
        snykToken: cfg.get('snykToken') || null
      });

      updateStatusBar(null, true);
      sidebarProvider.sendAnalyzingState(true);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '🔬 Analyse complète (AST + Sécurité + IA)…',
        cancellable: true
      }, async function (progress, token) {
        try {
          const result = await pipeline.run(
            editor.document.getText(),
            editor.document.languageId,
            editor.document.fileName,
            function (info) {
              progress.report({ message: info.step, increment: info.pct });
            }
          );

          if (token.isCancellationRequested) return;

          result._mode = 'full';
          lastAnalysisResult = result;
          lastAnalysisFile = editor.document.uri.toString() + '_' +
            simpleHash(editor.document.getText()) + '_' + editor.document.languageId;

          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'full',
            path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);

          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const w = (result.errors || []).filter(x => x.severity === 'warning').length;
          const s = result.score || 0;
          const medal = s >= 95 ? '🏆' : s >= 85 ? '✅' : s >= 70 ? '⚠️' : s >= 50 ? '🔶' : '❌';

          // Afficher le timing
          const timing = result.timing || {};
          const timingInfo = [
            timing.ast ? 'AST:' + timing.ast + 'ms' : null,
            timing.security ? 'Sécu:' + timing.security + 'ms' : null,
            timing.ai ? 'IA:' + timing.ai + 'ms' : null
          ].filter(Boolean).join(' · ');

          const msg = medal + ' Score: ' + s + '/100 — ' + e + ' erreur(s), ' +
            w + ' warning(s)' + (timingInfo ? ' (' + timingInfo + ')' : '');

          const action = await vscode.window.showInformationMessage(msg, 'Voir détails');
          if (action === 'Voir détails') {
            vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
          }
        } catch (err) {
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(null);
          vscode.window.showErrorMessage('Erreur pipeline: ' + err.message);
        }
      });
    })
  );

  // ── COMMANDE : Analyse locale (AST + Sécurité uniquement, sans IA — instantané)
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.analyzeLocal', function () {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Ouvrez un fichier !'); return; }

      const cfg = vscode.workspace.getConfiguration('aiAssistant');
      const wf = vscode.workspace.workspaceFolders;
      const workspacePath = wf ? wf[0].uri.fsPath : null;

      const pipeline = new AnalysisPipeline(analyzer, workspacePath, {
        useAST: cfg.get('useAST') !== false,
        useSecurity: true,
        useAI: false   // ← pas d'appel réseau
      });

      const result = pipeline.runLocal(
        editor.document.getText(),
        editor.document.languageId
      );

      result._mode = 'local';
      result.summary = result.errors.length === 0
        ? 'Aucun problème détecté localement (AST + OWASP).'
        : result.errors.length + ' problème(s) détecté(s) localement.';
      result.advice = result.advice || [];
      result.scoreDetails = result.scoreDetails || { breakdown: [] };

      diagnosticsManager.updateDiagnostics(editor.document, result.errors);
      sidebarProvider.sendAnalysisResult(result, 'local',
        path.basename(editor.document.fileName), editor.document.languageId);
      updateStatusBar(result.score);

      const e = result.errors.filter(x => x.severity === 'error').length;
      const w = result.errors.filter(x => x.severity === 'warning').length;

      if (e === 0 && w === 0) {
        vscode.window.showInformationMessage('✅ Analyse locale OK — aucun problème.');
      } else {
        vscode.window.showWarningMessage(
          '⚡ Analyse locale: ' + e + ' erreur(s), ' + w + ' warning(s)',
          'Voir détails'
        ).then(function (a) {
          if (a === 'Voir détails') {
            vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
          }
        });
      }
    })
  );
  // ── Auto-analyse à la sauvegarde (debounce 1.5s)
  let autoTimer = null;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async function(doc) {
      const cfg = vscode.workspace.getConfiguration('aiAssistant');
      if (!cfg.get('autoAnalyze') || !cfg.get('apiKey')) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;

      // Debounce — attend 1.5s après la dernière sauvegarde
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(async function() {
        const fileKey = doc.uri.toString() + '_' + simpleHash(doc.getText());
        if (lastAnalysisFile === fileKey && lastAnalysisResult) return; // cache hit

        sidebarProvider.sendAnalyzingState(true);
        try {
          analyzer.apiKey = cfg.get('apiKey');
          const result = await analyzer.analyzeFile(doc.getText(), doc.languageId);
          result._mode = 'analyze';
          lastAnalysisResult = result;
          lastAnalysisFile = fileKey;
          diagnosticsManager.updateDiagnostics(doc, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'analyze', path.basename(doc.fileName), doc.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);
          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const w = (result.errors || []).filter(x => x.severity === 'warning').length;
          const s = result.score || 0;
          const medal = s >= 95 ? '🏆' : s >= 85 ? '✅' : s >= 70 ? '⚠️' : s >= 50 ? '🔶' : '❌';
          if (e === 0 && w === 0) vscode.window.showInformationMessage(medal + ' Score: ' + s + '/100');
          else vscode.window.showWarningMessage(medal + ' Score: ' + s + '/100 — ' + e + ' erreur(s), ' + w + ' warning(s)', 'Voir détails').then(function(a) {
            if (a === 'Voir détails') vscode.commands.executeCommand('workbench.view.extension.aiAssistant');
setTimeout(() => vscode.commands.executeCommand('aiAssistant.sidebarView.focus'), 300);
          });
        } catch (err) {
          sidebarProvider.sendAnalyzingState(false);
          console.error('[AI Auto-analyse]', err.message);
        }
      }, 1500);
    })
  );

  // ── Restaure résultat quand on change de fichier
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(function(editor) {
      if (!editor) return;
      const fileKey = editor.document.uri.toString() + '_' + simpleHash(editor.document.getText()) + '_' + editor.document.languageId;
      if (lastAnalysisFile === fileKey && lastAnalysisResult) {
        sidebarProvider.sendAnalysisResult(lastAnalysisResult, lastAnalysisResult._mode || 'analyze');
        updateStatusBar(lastAnalysisResult.score);
      } else {
        updateStatusBar(null);
      }
    })
  );
}

function deactivate() {}
module.exports = { activate, deactivate };