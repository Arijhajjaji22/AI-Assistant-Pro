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

let currentAbortController = null;

function activate(context) {
  console.log('[AI Assistant] Activated');
// Restaurer depuis globalState (survit au rechargement)
let lastAnalysisResult = context.globalState.get('lastResult', null);
let lastAnalysisFile   = context.globalState.get('lastFile', null);
  const config = vscode.workspace.getConfiguration('aiAssistant');
  const analyzer = new AIAnalyzer(
    config.get('apiKey') || '', 
    config.get('language') || 'fr',
    config.get('model') || 'gemini-1.5-flash'
  );
  
  // -- Caching --
  analyzer.setCacheData(context.globalState.get('ai_cache_data', []));
  analyzer.onCacheUpdate = function(data) {
    context.globalState.update('ai_cache_data', data);
  };

  // -- Quota Lock Persistance -- Survive les rechargements VS Code
  const savedQuotaLock = context.globalState.get('ai_quota_lock', 0);
  if (savedQuotaLock > Date.now()) {
    analyzer.setQuotaLockTimestamp(savedQuotaLock);
    console.log('[AI] Quota lock restored, ' + analyzer.getQuotaRemainingSeconds() + 's restants');
  }
  analyzer._onQuotaLocked = function(ts) {
    context.globalState.update('ai_quota_lock', ts);
  };

  // Mettre à jour si les réglages changent
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('aiAssistant')) {
      const newCfg = vscode.workspace.getConfiguration('aiAssistant');
      analyzer.apiKey = newCfg.get('apiKey') || '';
      analyzer.language = newCfg.get('language') || 'fr';
      analyzer.model = newCfg.get('model') || 'gemini-1.5-flash';
    }
  });

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
        sidebarProvider.clearChat(); // On vide pour que les stats soient en haut
        sidebarProvider.sendAnalysisResult(lastAnalysisResult, lastAnalysisResult._mode || 'analyze');
        updateStatusBar(lastAnalysisResult.score);
        vscode.commands.executeCommand('aiAssistant.sidebarView.focus');
        vscode.window.showInformationMessage('📋 Résultat affiché depuis le cache.');
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
          context.globalState.update('lastResult', result);
          context.globalState.update('lastFile', fileKey);
          diagnosticsManager.updateDiagnostics(editor.document, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'analyze', path.basename(editor.document.fileName), editor.document.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);
          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const w = (result.errors || []).filter(x => x.severity === 'warning' || x.severity === 'info').length;
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

  // ── COMMANDE : Réinitialiser le verrou quota
  context.subscriptions.push(
    vscode.commands.registerCommand('aiAssistant.resetQuotaLock', function() {
      analyzer.setQuotaLockTimestamp(0);
      context.globalState.update('ai_quota_lock', 0);
      vscode.window.showInformationMessage('🔓 Verrou quota réinitialisé. Vous pouvez réessayer l\'IA.');
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

      // Récupère le meilleur fix disponible (suggestedFix ou depuis le fixCache)
      let bestFix = suggestedFix || '';
      if (!bestFix) {
        const allFixes = diagnosticsManager.getAllFixes();
        for (const [, data] of allFixes) {
          if (data.documentUri && data.documentUri.toString() === document.uri.toString() &&
              data.originalRange && data.originalRange.start.line === lineIndex &&
              data.fix && data.fix.trim().length > 0) {
            bestFix = data.fix;
            break;
          }
        }
      }

      const looksLikeCode = bestFix && (
        bestFix.includes(';') || bestFix.includes('=') ||
        bestFix.includes('(') || bestFix.includes('->') ||
        bestFix.includes('.')
      );

      // ── Fix local SANS API — fonctionne toujours même avec quota dépassé
      const applyLocalFix = async function() {
        if (!looksLikeCode) return false;
        const lineRange = document.lineAt(lineIndex).range;
        const lineIndent = (document.lineAt(lineIndex).text.match(/^(\s*)/) || ['', ''])[1];
        await editor.edit(b => b.replace(lineRange, lineIndent + bestFix.trim()));
        vscode.window.setStatusBarMessage('✅ Fix local appliqué (sans IA)', 4000);
        diagnosticsManager.removeDiagnosticsOnLines(document, [{ range: document.lineAt(lineIndex).range, text: '' }]);
        return true;
      };

      // ── Si quota dépassé → fix local direct depuis le cache, ZERO API
      if (analyzer.isQuotaLocked()) {
        const remaining = analyzer.getQuotaRemainingSeconds();
        const applied = await applyLocalFix();
        if (!applied) {
          vscode.window.showWarningMessage(
            '⏳ Quota IA dépassé — ' + remaining + 's. Corrigez manuellement.', 'Réinitialiser'
          ).then(a => {
            if (a === 'Réinitialiser') vscode.commands.executeCommand('aiAssistant.resetQuotaLock');
          });
        }
        return;
      }

      // ── Quota OK → essaie l'IA, fallback local si ça échoue
      const originalCode = methodRange ? document.getText(methodRange) : document.lineAt(lineIndex).text;
      const language = document.languageId;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: '🤖 AI Fix…'
      }, async function() {
        try {
          analyzer.apiKey = vscode.workspace.getConfiguration('aiAssistant').get('apiKey');
          if (!methodRange) { await applyLocalFix(); return; }

          const originalLineCount = originalCode.split('\n').length;
          const prompt =
            'Tu es un expert DEVELOPPEUR ' + language + '.\n' +
            'RÈGLE ABSOLUE: Retourne uniquement la méthode corrigée dans "refactored".\n' +
            'RÈGLE ABSOLUE: Même indentation, même structure, AUCUNE classe entière.\n' +
            'RÈGLE ABSOLUE: Si renommage de variable, renomme PARTOUT dans la méthode.\n\n' +
            'PROBLÈME: ' + errorMessage + '\n' +
            'SUGGESTION: ' + (suggestedFix || '') + '\n\n' +
            'MÉTHODE:\n```' + language + '\n' + originalCode + '\n```\n\n' +
            'Réponds en JSON avec "refactored" contenant la méthode corrigée.';

          const result = await analyzer.generateCode(prompt, language, '');
          if (!result.refactored || result.refactored.trim().length < 5) {
            await applyLocalFix();
            return;
          }

          let fixedCode = result.refactored.trim()
            .replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

          const instructionKeywords = ['Renommer', 'Modifier', 'Supprimer', 'Ajouter', 'Utiliser', 'Rename', 'Change'];
          if (instructionKeywords.some(kw => fixedCode.startsWith(kw) && fixedCode.split('\n').length < 3)) {
            await applyLocalFix(); return;
          }
          if (fixedCode.split('\n').length > originalLineCount * 2 ||
              fixedCode.includes('public class ') || fixedCode.includes('package ')) {
            await applyLocalFix(); return;
          }

          await editor.edit(b => b.replace(methodRange, fixedCode));
          vscode.window.setStatusBarMessage('✅ AI Fix appliqué', 4000);

          // Re-analyse locale après fix IA
          setTimeout(() => {
            try {
              const wf = vscode.workspace.workspaceFolders;
              const pipeline = new AnalysisPipeline(analyzer, wf ? wf[0].uri.fsPath : null, { useAI: false });
              const localResult = pipeline.runLocal(editor.document.getText(), language);
              
              // 1. On garde les anciennes erreurs Gemini qui sont HORS de la méthode qu'on vient de corriger
              const startL = methodRange.start.line + 1;
              const endL = methodRange.end.line + 1;
              const oldAIErrors = (lastAnalysisResult?.errors || []).filter(e => 
                e.source === 'gemini' && (e.line < startL || e.line > endL)
              );
              
              // 2. Fusion = erreurs structurelles locales + erreurs IA restantes
              const fusedErrors = [...localResult.errors, ...oldAIErrors];
              diagnosticsManager.updateDiagnostics(editor.document, fusedErrors);

              // 3. Calcul précis du score réel
              const remainingErrors = fusedErrors.filter(x => x.severity === 'error').length;
              const remainingWarnings = fusedErrors.filter(x => x.severity === 'warning' || x.severity === 'info').length;
              
              // Base 100, on retire les pénalités réelles
              let newScore = 100 - (remainingErrors * 10) - (remainingWarnings * 3);
              newScore = Math.max(0, Math.min(100, newScore));
              
              updateStatusBar(newScore);

              // Invalider cache mémoire + cache Gemini pour l'ancienne version du code
              // Ainsi si l'utilisateur Ctrl+Z pour revenir, Gemini re-analysera le fichier
              lastAnalysisResult = { ...localResult, errors: fusedErrors, score: newScore, _mode: 'local',
                summary: '🔄 Fix appliqué. Sauvegardez (Ctrl+S) pour confirmer avec une passe IA globale.' };
              lastAnalysisFile = null; // Force la prochaine sauvegarde à rappeler Gemini
              context.globalState.update('lastFile', null);
              analyzer.clearCacheForCode(editor.document.getText(), language);

              sidebarProvider.sendAnalysisResult(lastAnalysisResult, 'local');
            } catch (_) {}
          }, 1000);

        } catch (err) {
          // ── Fallback : si l'API échoue (quota ou autre), applique le fix local
          const applied = await applyLocalFix();
          if (!applied) vscode.window.showErrorMessage('AI Fix: ' + err.message);
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
          const w = (result.errors || []).filter(x => x.severity === 'warning' || x.severity === 'info').length;
          const s = result.score || 0;
          const medal = s >= 95 ? '🏆' : s >= 85 ? '✅' : s >= 70 ? '⚠️' : s >= 50 ? '🔶' : '❌';

          // Afficher le timing
          const timing = result.timing || {};
          const timingInfo = [
            timing.ast !== undefined ? 'AST:' + timing.ast + 'ms' : null,
            timing.security !== undefined ? 'Sécu:' + timing.security + 'ms' : null,
            timing.ai !== undefined ? 'IA:' + timing.ai + 'ms' : null
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
      const w = result.errors.filter(x => x.severity === 'warning' || x.severity === 'info').length;

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
        // fileKey DOIT inclure languageId pour matcher le format utilisé partout
        const fileKey = doc.uri.toString() + '_' + simpleHash(doc.getText()) + '_' + doc.languageId;
        if (lastAnalysisFile === fileKey && lastAnalysisResult) return; // cache hit

        sidebarProvider.sendAnalyzingState(true);
        try {
          analyzer.apiKey = cfg.get('apiKey');
          const result = await analyzer.analyzeFile(doc.getText(), doc.languageId);
          result._mode = 'analyze';
          lastAnalysisResult = result;
          lastAnalysisFile = fileKey;
          context.globalState.update('lastResult', result);
          context.globalState.update('lastFile', fileKey);
          diagnosticsManager.updateDiagnostics(doc, result.errors);
          sidebarProvider.sendAnalysisResult(result, 'analyze', path.basename(doc.fileName), doc.languageId);
          sidebarProvider.sendAnalyzingState(false);
          updateStatusBar(result.score);
          const e = (result.errors || []).filter(x => x.severity === 'error').length;
          const w = (result.errors || []).filter(x => x.severity === 'warning' || x.severity === 'info').length;
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

  // ── Retire les avertissements des lignes modifiées manuellement (Bug 1)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(function(e) {
      if (e.contentChanges && e.contentChanges.length > 0) {
        diagnosticsManager.removeDiagnosticsOnLines(e.document, e.contentChanges);
      }
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