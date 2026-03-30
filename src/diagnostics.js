const vscode = require('vscode');

class DiagnosticsManager {
  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-assistant');
    this.fixCache = new Map();
  }

  updateDiagnostics(document, errors) {
    this.diagnosticCollection.delete(document.uri);
    if (!errors || errors.length === 0) return;

    const diagnostics = [];

    errors.forEach((error) => {
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

      const severity = {
        'error':   vscode.DiagnosticSeverity.Error,
        'warning': vscode.DiagnosticSeverity.Warning,
        'info':    vscode.DiagnosticSeverity.Information
      }[error.severity] ?? vscode.DiagnosticSeverity.Warning;

      const diagnostic = new vscode.Diagnostic(range, error.message, severity);
      diagnostic.source = '🤖 AI Assistant';

      const codeId = `ai-fix-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      diagnostic.code = codeId;

      if (error.fix) {
        this.fixCache.set(codeId, {
          fix: error.fix,
          explanation: error.explanation,
          originalRange: range,
          documentUri: document.uri
        });
      }

      diagnostics.push(diagnostic);
    });

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  getFixForCode(codeValue) {
    return this.fixCache.get(codeValue);
  }

  clearDiagnostics(document) {
    this.diagnosticCollection.delete(document.uri);
  }

  clearAll() {
    this.diagnosticCollection.clear();
    this.fixCache.clear();
  }

  dispose() {
    this.diagnosticCollection.dispose();
  }
}

class AICodeActionProvider {
  constructor(diagnosticsManager) {
    this.diagnosticsManager = diagnosticsManager;
  }

  provideCodeActions(document, range, context) {
    const actions = [];

    const aiDiagnostics = context.diagnostics.filter(
      d => d.source === '🤖 AI Assistant'
    );

    aiDiagnostics.forEach(diagnostic => {
      const codeValue = diagnostic.code;
      const fixData = this.diagnosticsManager.getFixForCode(codeValue);

      if (fixData) {
        // Action 1 : Voir l'explication
        const explainAction = new vscode.CodeAction(
          `💡 Explication : ${diagnostic.message.substring(0, 40)}...`,
          vscode.CodeActionKind.QuickFix
        );
        explainAction.command = {
          command: 'aiAssistant.showExplanation',
          title: 'Voir l\'explication',
          arguments: [fixData.explanation || diagnostic.message, fixData.fix]
        };
        explainAction.diagnostics = [diagnostic];
        actions.push(explainAction);

        // Action 2 : Appliquer la correction
        const fixAction = new vscode.CodeAction(
          `🔧 Corriger : ${fixData.fix.substring(0, 50)}`,
          vscode.CodeActionKind.QuickFix
        );
        fixAction.command = {
          command: 'aiAssistant.applyFix',
          title: 'Appliquer la correction',
          arguments: [document, diagnostic.range, fixData.fix]
        };
        fixAction.diagnostics = [diagnostic];
        fixAction.isPreferred = true;
        actions.push(fixAction);
      }
    });

    return actions;
  }
}

module.exports = { DiagnosticsManager, AICodeActionProvider };