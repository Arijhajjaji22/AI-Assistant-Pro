/**
 * pipeline.js — Orchestration style LangChain.js
 *
 * Pipeline complet :
 *   1. AST Analysis    (Tree-sitter — structurel, local)
 *   2. Security Scan   (OWASP local + Snyk optionnel)
 *   3. AI Analysis     (Gemini — sémantique)
 *   4. Score Fusion    (combine les 3 sources)
 *   5. Auto-Fix        (Gemini corrige les erreurs critiques)
 *   6. Git Commit      (branche ai-fix/ optionnel)
 *
 * Chaque étape est une "Chain" — peut être activée/désactivée.
 */

const { ASTAnalyzer }      = require('./astAnalyzer');
const { SecurityScanner }  = require('./securityScanner');
const { GitManager }       = require('./gitManager');

class AnalysisPipeline {
  constructor(analyzer, workspacePath, options = {}) {
    this.analyzer        = analyzer;          // AIAnalyzer (Gemini)
    this.astAnalyzer     = new ASTAnalyzer();
    this.securityScanner = new SecurityScanner(options.snykToken || null);
    this.gitManager      = workspacePath ? new GitManager(workspacePath) : null;
    this.options         = {
      useAST:      options.useAST      !== false,  // activé par défaut
      useSecurity: options.useSecurity !== false,
      useAI:       options.useAI       !== false,
      autoFix:     options.autoFix     || false,   // désactivé par défaut
      autoCommit:  options.autoCommit  || false,
      ...options
    };
  }

  // ══════════════════════════════════════════════════
  //  Pipeline principal — analyse complète
  // ══════════════════════════════════════════════════
  async run(code, languageId, filePath, onProgress) {
    const results = {
      errors:       [],
      summary:      '',
      score:        100,
      scoreDetails: { breakdown: [] },
      advice:       [],
      sources:      {},
      timing:       {}
    };

    const emit = (step, pct) => onProgress && onProgress({ step, pct });

    // ── Étape 1 : AST Analysis (local, <50ms)
    if (this.options.useAST && this.astAnalyzer.isAvailable()) {
      emit('AST Analysis...', 10);
      const t0 = Date.now();
      const astResult = this.astAnalyzer.getMetrics(code, languageId);
      results.timing.ast = Date.now() - t0;

      if (astResult) {
        results.sources.ast = astResult;
        // Les erreurs AST sont prioritaires (structurelles)
        astResult.errors.forEach(e => {
          e.source = 'ast';
          results.errors.push(e);
        });
      }
    }

    // ── Étape 2 : Security Scan (local OWASP, <10ms)
    if (this.options.useSecurity) {
      emit('Security Scan...', 25);
      const t0 = Date.now();
      const secErrors = this.securityScanner.scanLocal(code, languageId);
      results.timing.security = Date.now() - t0;

      if (secErrors.length > 0) {
        results.sources.security = secErrors;
        secErrors.forEach(e => {
          e.source = 'owasp';
          results.errors.push(e);
        });
      }
    }

    // ── Étape 3 : AI Analysis (Gemini, ~5-15s)
    if (this.options.useAI) {
      emit('AI Analysis...', 40);
      const t0 = Date.now();
      try {
        const aiResult = await this.analyzer.analyzeFile(code, languageId);
        results.timing.ai = Date.now() - t0;
        results.sources.ai = aiResult;

        // Merge erreurs IA (évite les doublons de ligne)
        const existingLines = new Set(results.errors.map(e => e.line));
        (aiResult.errors || []).forEach(e => {
          e.source = 'gemini';
          // Ajoute seulement si pas déjà signalé par AST/OWASP sur la même ligne
          if (!e.line || !existingLines.has(e.line)) {
            results.errors.push(e);
            if (e.line) existingLines.add(e.line);
          }
        });

        // Garde le summary et advice de l'IA
        results.summary  = aiResult.summary || '';
        results.advice   = aiResult.advice || [];
        results.scoreDetails = aiResult.scoreDetails || { breakdown: [] };
      } catch (err) {
        console.error('[Pipeline] AI step failed:', err.message);
        results.sources.aiError = err.message;
      }
    }

    // ── Étape 4 : Score Fusion
    emit('Score Fusion...', 70);
    results.score = this._fuseScores(results);

    // ── Étape 5 : Auto-Fix (optionnel)
    if (this.options.autoFix && results.errors.length > 0) {
      emit('Auto-Fix...', 80);
      const criticalErrors = results.errors.filter(e => e.severity === 'error').slice(0, 3);
      if (criticalErrors.length > 0) {
        try {
          const fixResult = await this._autoFix(code, languageId, criticalErrors);
          results.fixedCode = fixResult.code;
          results.fixSummary = fixResult.summary;
        } catch (err) {
          console.error('[Pipeline] AutoFix failed:', err.message);
        }
      }
    }

    // ── Étape 6 : Git Commit (optionnel)
    if (this.options.autoCommit && results.fixedCode && filePath && this.gitManager?.isGitRepo()) {
      emit('Git Commit...', 90);
      try {
        const gitResult = await this.gitManager.createFixBranch(
          filePath,
          criticalErrors.map(e => e.message).join(', ').substring(0, 72),
          code,
          results.fixedCode
        );
        results.gitBranch = gitResult.branch;
      } catch (err) {
        console.error('[Pipeline] Git commit failed:', err.message);
      }
    }

    emit('Done', 100);
    return results;
  }

  // ── Fusion des scores (pondérée par source)
  _fuseScores(results) {
    const { sources } = results;
    let score = 100;

    // Pénalités AST (structurel)
    if (sources.ast) {
      score -= sources.ast.longFunctions   * 5;
      score -= sources.ast.highComplexity  * 5;
      score -= sources.ast.duplications    * 4;
      score -= sources.ast.deepNesting     * 3;
      score -= Math.min(sources.ast.badNames * 2, 9);
    }

    // Pénalités sécurité OWASP
    if (sources.security) {
      const critSec = sources.security.filter(e => e.severity === 'error').length;
      const warnSec = sources.security.filter(e => e.severity === 'warning').length;
      score -= critSec * 15;
      score -= warnSec * 5;
    }

    // Score IA comme référence (moyenne pondérée si disponible)
    if (sources.ai && sources.ai.score !== null && sources.ai.score !== undefined) {
      // 60% score IA + 40% nos calculs
      score = Math.round(sources.ai.score * 0.6 + score * 0.4);
    }

    return Math.max(0, Math.min(100, score));
  }

  // ── Auto-fix des erreurs critiques
  async _autoFix(code, languageId, errors) {
    const errorList = errors.map((e, i) =>
      (i + 1) + '. Ligne ' + e.line + ': ' + e.message + (e.fix ? ' → ' + e.fix : '')
    ).join('\n');

    const result = await this.analyzer.generateCode(
      'Corrige ces erreurs dans le code:\n' + errorList + '\n\nCode original:\n```' + languageId + '\n' + code + '\n```',
      languageId,
      ''
    );

    return {
      code: result.refactored || code,
      summary: result.summary || 'Corrections appliquées'
    };
  }

  // ── Pipeline léger (AST + Security uniquement, sans IA)
  runLocal(code, languageId) {
    const errors = [];

    if (this.options.useAST && this.astAnalyzer.isAvailable()) {
      const astResult = this.astAnalyzer.getMetrics(code, languageId);
      if (astResult) astResult.errors.forEach(e => { e.source = 'ast'; errors.push(e); });
    }

    if (this.options.useSecurity) {
      const secErrors = this.securityScanner.scanLocal(code, languageId);
      secErrors.forEach(e => { e.source = 'owasp'; errors.push(e); });
    }

    return { errors, score: this._fuseScores({ errors, sources: {} }) };
  }
}

module.exports = { AnalysisPipeline };