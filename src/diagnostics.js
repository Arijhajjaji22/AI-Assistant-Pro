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

  getAllFixes() { return this.fixCache; }
  getFixForCode(codeValue) { return this.fixCache.get(codeValue); }
  clearDiagnostics(document) { this.diagnosticCollection.delete(document.uri); }

  removeDiagnosticsOnLines(document, contentChanges) {
    const diagnostics = this.diagnosticCollection.get(document.uri);
    if (!diagnostics || diagnostics.length === 0) return;

    const changedLines = new Set();
    contentChanges.forEach(change => {
      const startLine = change.range.start.line;
      const addedNewLines = (change.text.match(/\n/g) || []).length;
      const endLine = change.range.end.line + addedNewLines;
      for (let i = startLine; i <= endLine; i++) {
        changedLines.add(i);
      }
    });

    const remaining = diagnostics.filter(diag => !changedLines.has(diag.range.start.line));
    if (remaining.length !== diagnostics.length) {
      this.diagnosticCollection.set(document.uri, remaining);
    }
  }

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
    const lineIndex = range.start.line;
    const lineText = document.lineAt(lineIndex).text;

    // 1. Diagnostics IA spécifiques (souligné jaune/bleu)
    const aiDiagnostics = context.diagnostics.filter(d => d.source === '🤖 AI Assistant');
    
    aiDiagnostics.forEach(diagnostic => {
      const fixData = this.diagnosticsManager.getFixForCode(diagnostic.code);
      if (!fixData) return;

      const fix = (fixData.fix || '').trim();
      const indent = lineText.match(/^(\s*)/)[1];

      // Fix inline (style Copilot)
      const inlineFix = this._buildInlineFix(document, lineIndex, lineText, indent, fix, diagnostic);
      if (inlineFix) {
        inlineFix.isPreferred = true; // IMPORTANT : priorité max
        actions.push(inlineFix);
      }

      // Fix global via IA
      const methodRange = this._findMethodRange(document, lineIndex);
      const aiAction = new vscode.CodeAction('🤖 Corriger avec IA', vscode.CodeActionKind.QuickFix);
      aiAction.command = {
        command: 'aiAssistant.fixWithAI',
        title: 'Corriger avec IA',
        arguments: [document, methodRange, lineIndex, diagnostic.message, fix, fixData.explanation, indent]
      };
      aiAction.diagnostics = [diagnostic];
      aiAction.isPreferred = !inlineFix;
      actions.push(aiAction);

      // Explication
      const explainAction = new vscode.CodeAction('💡 Voir explication', vscode.CodeActionKind.QuickFix);
      explainAction.command = {
        command: 'aiAssistant.showExplanation',
        title: 'Voir explication',
        arguments: [fixData.explanation || diagnostic.message, fix]
      };
      explainAction.diagnostics = [diagnostic];
      actions.push(explainAction);
    });

    // 2. Diagnostics NATIFS (souligné rouge/orange - Compilation)
    // Heuristique : Détecter un "cannot be resolved" (m n'existe plus après renommage en statMap)
    const compilerErrors = context.diagnostics.filter(d => (d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning) && d.source !== '🤖 AI Assistant');
    
    if (compilerErrors.length > 0) {
      const diag = compilerErrors[0];
      const msg = diag.message;
      // Regex plus souple pour capturer la variable inconnue (m)
      const unresolvedMatch = msg.match(/^(\w+)\s+(?:cannot|is not|n'est pas)/i);
      
      if (unresolvedMatch) {
        const oldVar = unresolvedMatch[1];
        const methodRange = this._findMethodRange(document, lineIndex);
        
        if (methodRange) {
          // Chercher une variable récemment déclarée (Candidat de remplacement)
          let candidateVar = null;
          for (let i = Math.max(methodRange.start.line, lineIndex - 15); i < lineIndex; i++) {
            const l = document.lineAt(i).text.trim();
            // Regex Java/TS robuste : Type<G1, G2> nomVar = ...
            const declMatch = l.match(/^(?:[\w<>, \s\[\]]+)\s+(\w+)\s*=[^=]/);
            if (declMatch) {
              const name = declMatch[1];
              const keywords = ['return', 'throw', 'if', 'for', 'while', 'new', 'final', 'public', 'private', 'protected'];
              if (!keywords.includes(name) && name !== oldVar) {
                candidateVar = name;
              }
            }
          }

          if (candidateVar) {
            let extraEdits = [];
            const varRegex = new RegExp('\\b' + oldVar + '\\b', 'g');
            // Scanner de la ligne d'erreur jusqu'à la fin de la méthode
            for (let j = lineIndex; j <= methodRange.end.line; j++) {
              const rowText = document.lineAt(j).text;
              if (varRegex.test(rowText)) {
                extraEdits.push({ range: document.lineAt(j).range, newText: rowText.replace(varRegex, candidateVar) });
              }
            }

            if (extraEdits.length > 0) {
              const renameAction = this._makeEditAction(
                `🔧 Remplacer partout '${oldVar}' par '${candidateVar}' (IA Recommandé)`,
                document, extraEdits[0].range, extraEdits[0].newText, diag, true, extraEdits.slice(1)
              );
              renameAction.isPreferred = true; 
              actions.unshift(renameAction); // On l'ajoute au DÉBUT de la liste !
            }
          }
        }
      }

      // Fallback : Proposer Fix/Explain génériques pour n'importe quelle erreur
      const genericFix = new vscode.CodeAction('🤖 Fix par IA (Rewriting)', vscode.CodeActionKind.QuickFix);
      genericFix.command = {
        command: 'aiAssistant.fixWithAI',
        title: 'Fix par IA',
        arguments: [document, this._findMethodRange(document, lineIndex), lineIndex, msg, '', '', '']
      };
      actions.push(genericFix);
    }

    return actions;
  }

  // ── Tente de construire un fix inline direct (comme Copilot)
 _buildInlineFix(document, lineIndex, lineText, indent, fix, diagnostic) {
  if (!fix || !this._isCleanOneLiner(fix)) return null;

  // Cas 1 : RuntimeException → autre Exception
  const newExMatch = fix.match(/new\s+([\w.]+(?:Exception|Error))\s*\(/);
  if (newExMatch && lineText.includes('RuntimeException')) {
    const replacement = fix.match(/new[\w\s.]+\([^)]*\)/);
    if (replacement) {
      const fixedLine = lineText.replace(/new RuntimeException\s*\([^)]*\)/, replacement[0]);
      if (fixedLine !== lineText) {
        return this._makeEditAction(
          '🔧 ' + newExMatch[1] + ' (fix direct)',
          document, document.lineAt(lineIndex).range, fixedLine, diagnostic, true
        );
      }
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
          const fixedLine = li + t.trim().replace(/\.orElseThrow\([^)]*\)/, orElseMatch[0]);
          return this._makeEditAction(
            '🔧 Meilleure exception orElseThrow',
            document, document.lineAt(i).range, fixedLine, diagnostic, true
          );
        }
      }
    }
  }

  // ⛔ PAS de remplacement de ligne entière pour des fixes comme
  // "public class TimeEntryManager {" ou "List<Map<...>> result = new ArrayList<>(rows.size());"
  // car cela casse le contexte du code environnant.
  // On ne fait le remplacement que si le fix est TRÈS similaire à la ligne existante.

  // Cas 3 : fix ressemble à la même ligne avec une petite modification
  const lineClean = lineText.trim();
  const fixClean  = fix.trim();

  // Le fix doit partager au moins 40% des mots avec la ligne originale
  const lineWords = new Set(lineClean.split(/\W+/).filter(w => w.length > 2));
  const fixWords  = fixClean.split(/\W+/).filter(w => w.length > 2);
  const commonWords = fixWords.filter(w => lineWords.has(w)).length;
  const similarity = lineWords.size > 0 ? commonWords / lineWords.size : 0;

  if (similarity >= 0.4 && fixClean.length < 200) {
    let extraEdits = [];
    
    // Détection de renommage de variable
    const oldTokens = lineClean.match(/\b\w+\b/g) || [];
    const newTokens = fixClean.match(/\b\w+\b/g) || [];
    const removedTokens = oldTokens.filter(t => !newTokens.includes(t) && t.length >= 1 && t.length <= 25);
    const addedTokens = newTokens.filter(t => !oldTokens.includes(t));
    
    if (removedTokens.length === 1 && addedTokens.length === 1) {
      const oldVar = removedTokens[0];
      const newVar = addedTokens[0];
      
      const methodRange = this._findMethodRange(document, lineIndex);
      if (methodRange) {
        for (let i = lineIndex + 1; i <= methodRange.end.line; i++) {
          const lText = document.lineAt(i).text;
          const varRegex = new RegExp('\\b' + oldVar + '\\b', 'g');
          if (varRegex.test(lText)) {
            extraEdits.push({
              range: document.lineAt(i).range,
              newText: lText.replace(varRegex, newVar)
            });
          }
        }
      }
    }

    const actionTitle = extraEdits.length > 0 ? '🔧 Fix rapide (Renommer partout)' : '🔧 Fix rapide';
    return this._makeEditAction(
      actionTitle,
      document, document.lineAt(lineIndex).range, indent + fix.trimStart(), diagnostic, true, extraEdits
    );
  }

  return null;
}

  _makeEditAction(title, document, range, newText, diagnostic, isPreferred, extraEdits = []) {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, range, newText);
    
    extraEdits.forEach(edit => {
      action.edit.replace(document.uri, edit.range, edit.newText);
    });
    
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
    const textualPattern = /^(Utiliser|Ajouter|Créer|Remplacer|Supprimer|Implémenter|Vérifier|Extraire|Décomposer|Ensure|Use|Add|Create|Replace|Remove|Implement|Check|Extract|Refactor)\s/i;
    if (textualPattern.test(fix)) return false;
    // Vérifie équilibre des parenthèses
    let p = 0;
    for (const c of fix) { if (c === '(') p++; else if (c === ')') p--; }
    return p === 0;
  }

  // Détecte si le fix ressemble à une vraie ligne de code
  _looksLikeCompleteLine(fix, languageId) {
  // Cette méthode n'est plus utilisée — la logique est dans _buildInlineFix
  return false;
}

  // Trouve la méthode/fonction englobante pour le rewrite IA
 _findMethodRange(document, lineIndex) {
  const lineText = document.lineAt(lineIndex).text;

  // ── Si la ligne est un champ de classe (private/protected final...)
  // → pas de méthode englobante, on retourne null
  if (/^\s*(private|protected|public)\s+(final\s+)?[\w<>[\],\s]+\s+\w+\s*;/.test(lineText)) {
    return null;
  }

  // ── Cherche la méthode englobante en remontant
  let methodStart = -1;
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 80); i--) {
    const text = document.lineAt(i).text;

    // Détecte le début d'une méthode Java/JS/Python
    const isJavaMethod = /^\s+(public|private|protected)[\w\s<>[\],@]+\s+\w+\s*\([^)]*\)\s*(throws\s+[\w,\s]+)?\s*\{/.test(text);
    const isJSMethod   = /^\s*(async\s+)?function\s+\w+|^\s*\w+\s*\([^)]*\)\s*\{|^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(text);
    const isPyMethod   = /^\s*def\s+\w+/.test(text);

    if (isJavaMethod || isJSMethod || isPyMethod) {
      methodStart = i;
      break;
    }
  }

  if (methodStart === -1) return null;

  // ── Vérifie que lineIndex est DANS cette méthode (pas avant)
  if (lineIndex < methodStart) return null;

  // ── Trouve la fermeture de la méthode
  let braceCount = 0, foundOpen = false, methodEnd = -1;
  for (let i = methodStart; i < Math.min(document.lineCount, methodStart + 120); i++) {
    for (const c of document.lineAt(i).text) {
      if (c === '{') { braceCount++; foundOpen = true; }
      else if (c === '}') { braceCount--; }
    }
    if (foundOpen && braceCount === 0) {
      methodEnd = i;
      break;
    }
  }

  if (methodEnd === -1 || methodEnd <= methodStart) return null;

  // ── Vérifie que lineIndex est DANS la méthode trouvée
  if (lineIndex > methodEnd) return null;

  return new vscode.Range(methodStart, 0, methodEnd, document.lineAt(methodEnd).text.length);
}
}

module.exports = { DiagnosticsManager, AICodeActionProvider };