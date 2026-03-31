const vscode = require('vscode');

// ══════════════════════════════════════════════════════
//  DiagnosticsManager
//  Gère les soulignements rouges/jaunes dans l'éditeur
// ══════════════════════════════════════════════════════
class DiagnosticsManager {
  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-assistant');
    this.fixCache = new Map(); // codeId → { fix, explanation, range, documentUri }
  }

  updateDiagnostics(document, errors) {
    this.diagnosticCollection.delete(document.uri);
    if (!errors || errors.length === 0) return;

    const diagnostics = [];

    errors.forEach(function(error) {
      // Ignore les lignes qui sont des commentaires
      if (error.line && error.line > 0) {
        const lineIndex = error.line - 1;
        if (lineIndex < document.lineCount) {
          const lineText = document.lineAt(lineIndex).text.trim();
          if (lineText.startsWith('//') || lineText.startsWith('/*') || lineText.startsWith('*')) return;
        }
      }

      let range;
      if (error.line && error.line > 0) {
        const lineIndex = error.line - 1;
        if (lineIndex < document.lineCount) {
          const line = document.lineAt(lineIndex);
          range = new vscode.Range(
            lineIndex, line.firstNonWhitespaceCharacterIndex,
            lineIndex, line.text.length
          );
        }
      }
      if (!range) {
        range = new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
      }

      const severity = ({
        'error':   vscode.DiagnosticSeverity.Error,
        'warning': vscode.DiagnosticSeverity.Warning,
        'info':    vscode.DiagnosticSeverity.Information
      })[error.severity] || vscode.DiagnosticSeverity.Warning;

      const diagnostic = new vscode.Diagnostic(range, error.message, severity);
      diagnostic.source = '🤖 AI Assistant';

      // ID unique pour retrouver le fix dans le cache
      const codeId = 'ai-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
      diagnostic.code = codeId;

      if (error.fix) {
        this.fixCache.set(codeId, {
          fix: error.fix,
          explanation: error.explanation || '',
          originalRange: range,
          documentUri: document.uri
        });
      }

      diagnostics.push(diagnostic);
    }.bind(this));

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  getFixForCode(codeValue) { return this.fixCache.get(codeValue); }
  clearDiagnostics(document) { this.diagnosticCollection.delete(document.uri); }
  clearAll() { this.diagnosticCollection.clear(); this.fixCache.clear(); }
  dispose() { this.diagnosticCollection.dispose(); }
}

// ══════════════════════════════════════════════════════
//  AICodeActionProvider  — l'ampoule 💡
//
//  VS Code appelle cette méthode AUTOMATIQUEMENT quand
//  le curseur est sur une ligne avec un diagnostic.
//  L'ampoule apparaît sans que l'utilisateur clique.
//
//  Actions proposées (style Copilot) :
//    1. 🔧 Fix rapide inline  (si le fix est du code exact)
//    2. 🤖 Corriger avec IA   (rewrite de la méthode entière)
//    3. 💡 Pourquoi ?          (explication modale)
// ══════════════════════════════════════════════════════
class AICodeActionProvider {
  constructor(diagnosticsManager, analyzer) {
    this.diagnosticsManager = diagnosticsManager;
    this.analyzer = analyzer;
  }

  provideCodeActions(document, range, context) {
    const actions = [];

    // Filtre uniquement nos diagnostics
    const aiDiagnostics = context.diagnostics.filter(function(d) {
      return d.source === '🤖 AI Assistant';
    });

    aiDiagnostics.forEach(function(diagnostic) {
      const fixData = this.diagnosticsManager.getFixForCode(diagnostic.code);
      if (!fixData) return;

      const fix = (fixData.fix || '').trim();
      const lineIndex = diagnostic.range.start.line;
      const lineText  = document.lineAt(lineIndex).text;
      const indent    = lineText.match(/^(\s*)/)[1];

      // ── Action 1 : Fix inline immédiat (si code exact détecté)
      const inlineFix = this._buildInlineFix(document, lineIndex, lineText, indent, fix, diagnostic);
      if (inlineFix) {
        actions.push(inlineFix);
      }

      // ── Action 2 : Corriger avec IA (rewrite de la méthode)
      const methodRange = this._findMethodRange(document, lineIndex);
      const aiAction = new vscode.CodeAction('🤖 Corriger avec IA', vscode.CodeActionKind.QuickFix);
      aiAction.command = {
        command: 'aiAssistant.fixWithAI',
        title: 'Corriger avec IA',
        arguments: [document, methodRange, lineIndex, diagnostic.message, fix, fixData.explanation, indent]
      };
      aiAction.diagnostics = [diagnostic];
      aiAction.isPreferred = !inlineFix; // préféré si pas de fix inline
      actions.push(aiAction);

      // ── Action 3 : Explication
      const explainAction = new vscode.CodeAction(
        '💡 ' + diagnostic.message.substring(0, 50) + (diagnostic.message.length > 50 ? '…' : ''),
        vscode.CodeActionKind.QuickFix
      );
      explainAction.command = {
        command: 'aiAssistant.showExplanation',
        title: 'Voir explication',
        arguments: [fixData.explanation || diagnostic.message, fix]
      };
      explainAction.diagnostics = [diagnostic];
      actions.push(explainAction);

    }.bind(this));

    return actions;
  }

  // ── Tente de construire un fix inline direct (comme Copilot)
  _buildInlineFix(document, lineIndex, lineText, indent, fix, diagnostic) {
    if (!fix || !this._isCleanOneLiner(fix)) return null;

    // Cas 1 : RuntimeException → autre Exception
    const newExMatch = fix.match(/new\s+([\w.]+(?:Exception|Error))\s*\(/);
    if (newExMatch && lineText.includes('RuntimeException')) {
      const fixedLine = lineText.replace(/new RuntimeException\s*\([^)]*\)/, fix.match(/new[\w\s.]+\([^)]*\)/)[0]);
      if (fixedLine !== lineText) {
        return this._makeEditAction(
          '🔧 ' + newExMatch[1] + ' (fix direct)',
          document, document.lineAt(lineIndex).range, fixedLine, diagnostic, true
        );
      }
    }

    // Cas 2 : .orElseThrow() → meilleure exception
    if (fix.includes('orElseThrow')) {
      for (let i = lineIndex; i <= Math.min(lineIndex + 4, document.lineCount - 1); i++) {
        const t = document.lineAt(i).text;
        if (t.includes('.orElseThrow(')) {
          const orElseMatch = fix.match(/\.orElseThrow\(\(\)\s*->\s*new\s+[\w.]+[^)]*\)\)/);
          if (orElseMatch) {
            const li = t.match(/^(\s*)/)[1];
            return this._makeEditAction(
              '🔧 Meilleure exception orElseThrow',
              document, document.lineAt(i).range, li + orElseMatch[0].trimStart() + ';', diagnostic, true
            );
          }
        }
      }
    }

    // Cas 3 : ligne entière remplaçable (fix ressemble à une ligne Java/JS complète)
    if (this._looksLikeCompleteLine(fix, document.languageId)) {
      return this._makeEditAction(
        '🔧 Fix rapide',
        document, document.lineAt(lineIndex).range, indent + fix.trimStart(), diagnostic, true
      );
    }

    return null;
  }

  _makeEditAction(title, document, range, newText, diagnostic, isPreferred) {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, range, newText);
    action.diagnostics = [diagnostic];
    action.isPreferred = !!isPreferred;
    return action;
  }

  // Vérifie que le fix est du code sur une ligne, pas une description
  _isCleanOneLiner(fix) {
    if (!fix) return false;
    if (fix.includes('\n')) return false;
    if (fix.length > 200) return false;
    // C'est une description textuelle si ça commence par une majuscule et pas un mot-clé code
    const textualPattern = /^(Utiliser|Ajouter|Créer|Remplacer|Supprimer|Implémenter|Vérifier|Ensure|Use|Add|Create|Replace|Remove|Implement|Check)\s/i;
    if (textualPattern.test(fix)) return false;
    // Vérifie équilibre des parenthèses
    let p = 0;
    for (const c of fix) { if (c === '(') p++; else if (c === ')') p--; }
    return p === 0;
  }

  // Détecte si le fix ressemble à une vraie ligne de code
  _looksLikeCompleteLine(fix, languageId) {
    if (['java', 'kotlin'].includes(languageId)) {
      return /\w+\s*[=({]|return\s+\w|throw\s+new|\.[\w(]/.test(fix);
    }
    if (['javascript', 'typescript'].includes(languageId)) {
      return /const\s+|let\s+|return\s+|=>|\.map\(|\.filter\(|\.join\(/.test(fix);
    }
    if (languageId === 'python') {
      return /^\s*(return|raise|=|if |for |with )/.test(fix);
    }
    return false;
  }

  // Trouve la méthode/fonction englobante pour le rewrite IA
  _findMethodRange(document, lineIndex) {
    let methodStart = lineIndex;

    // Remonte pour trouver le début de la méthode
    for (let i = lineIndex; i >= Math.max(0, lineIndex - 60); i--) {
      const text = document.lineAt(i).text;
      const isFuncStart =
        /^\s*(public|private|protected|static|async|override)\s/.test(text) ||
        /^\s*(function\s+\w+|const\s+\w+\s*=\s*(async\s*)?\(|\w+\s*\([^)]*\)\s*\{)/.test(text) ||
        /^\s*def\s+\w+/.test(text);

      if (isFuncStart && text.includes('{') || (isFuncStart && i < lineIndex)) {
        // Inclut les annotations/commentaires au-dessus
        let start = i;
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const prev = document.lineAt(j).text.trim();
          if (prev.startsWith('@') || prev.startsWith('*') || prev.startsWith('/**') || prev.startsWith('//')) {
            start = j;
          } else if (prev === '' || prev === '}') break;
        }
        methodStart = start;
        break;
      }
    }

    // Descend pour trouver la fermeture de la méthode
    let braceCount = 0, foundOpen = false, methodEnd = lineIndex;
    for (let i = methodStart; i < Math.min(document.lineCount, methodStart + 100); i++) {
      for (const c of document.lineAt(i).text) {
        if (c === '{') { braceCount++; foundOpen = true; }
        else if (c === '}') braceCount--;
      }
      if (foundOpen && braceCount === 0) { methodEnd = i; break; }
    }

    if (methodEnd <= methodStart) return null;
    return new vscode.Range(methodStart, 0, methodEnd, document.lineAt(methodEnd).text.length);
  }
}

module.exports = { DiagnosticsManager, AICodeActionProvider };