/**
 * astAnalyzer.js — Analyse structurelle via Tree-sitter
 * Détecte patterns, complexité cyclomatique, fonctions longues,
 * code dupliqué, noms non descriptifs — sur l'AST réel du code.
 */

let Parser, JavaLanguage, JSLanguage, TSLanguage, PythonLanguage;

// Chargement lazy — Tree-sitter est optionnel
function loadTreeSitter() {
  try {
    Parser = require('tree-sitter');
    try { JavaLanguage   = require('tree-sitter-java'); } catch (_) {}
    try { JSLanguage     = require('tree-sitter-javascript'); } catch (_) {}
    try { TSLanguage     = require('tree-sitter-typescript').typescript; } catch (_) {}
    try { PythonLanguage = require('tree-sitter-python'); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

const LANGUAGE_MAP = {
  java:       () => JavaLanguage,
  javascript: () => JSLanguage,
  typescript: () => TSLanguage,
  python:     () => PythonLanguage
};

class ASTAnalyzer {
  constructor() {
    this.available = loadTreeSitter();
    this.parsers = {};
  }

  isAvailable() { return this.available; }

  // ── Obtenir ou créer le parser pour un langage
  _getParser(languageId) {
    if (this.parsers[languageId]) return this.parsers[languageId];
    const getLang = LANGUAGE_MAP[languageId];
    if (!getLang) return null;
    const lang = getLang();
    if (!lang) return null;
    const parser = new Parser();
    parser.setLanguage(lang);
    this.parsers[languageId] = parser;
    return parser;
  }

  // ── Analyse complète — retourne des erreurs compatibles avec DiagnosticsManager
  analyze(code, languageId) {
    if (!this.available) return { errors: [], astAvailable: false };

    const parser = this._getParser(languageId);
    if (!parser) return { errors: [], astAvailable: false };

    try {
      const tree = parser.parse(code);
      const lines = code.split('\n');
      const errors = [];

      this._detectLongFunctions(tree.rootNode, lines, languageId, errors);
      this._detectHighComplexity(tree.rootNode, lines, languageId, errors);
      this._detectBadNames(tree.rootNode, lines, languageId, errors);
      this._detectDuplication(lines, errors);
      this._detectDeepNesting(tree.rootNode, lines, errors);

      return { errors, astAvailable: true, tree };
    } catch (e) {
      console.error('[AST] Parse error:', e.message);
      return { errors: [], astAvailable: false };
    }
  }

  // ── Fonctions > 30 lignes
  _detectLongFunctions(node, lines, languageId, errors) {
    const funcTypes = {
      java:       ['method_declaration', 'constructor_declaration'],
      javascript: ['function_declaration', 'function', 'arrow_function', 'method_definition'],
      typescript: ['function_declaration', 'function', 'arrow_function', 'method_definition'],
      python:     ['function_definition']
    }[languageId] || [];

    this._walkNode(node, (n) => {
      if (!funcTypes.includes(n.type)) return;
      const startLine = n.startPosition.row;
      const endLine   = n.endPosition.row;
      const lineCount = endLine - startLine + 1;

      if (lineCount > 30) {
        // Trouver le nom de la fonction
        const nameNode = n.childForFieldName('name') || n.children.find(c => c.type === 'identifier');
        const name = nameNode ? nameNode.text : 'anonyme';

        errors.push({
          line: startLine + 1,
          severity: 'warning',
          message: 'Fonction "' + name + '" trop longue (' + lineCount + ' lignes > 30)',
          fix: 'Extraire en sous-méthodes (Single Responsibility Principle)',
          explanation: 'Une fonction > 30 lignes viole le SRP et réduit la lisibilité.',
          source: 'ast'
        });
      }
    });
  }

  // ── Complexité cyclomatique élevée (compte les branches)
  _detectHighComplexity(node, lines, languageId, errors) {
    const branchNodes = new Set([
      'if_statement', 'else_clause', 'for_statement', 'for_in_statement',
      'while_statement', 'do_statement', 'catch_clause', 'switch_case',
      'ternary_expression', 'binary_expression', 'conditional_expression'
    ]);

    const funcTypes = {
      java:       ['method_declaration'],
      javascript: ['function_declaration', 'function', 'arrow_function', 'method_definition'],
      typescript: ['function_declaration', 'function', 'arrow_function', 'method_definition'],
      python:     ['function_definition']
    }[languageId] || [];

    this._walkNode(node, (n) => {
      if (!funcTypes.includes(n.type)) return;
      let complexity = 1;
      this._walkNode(n, (child) => {
        if (branchNodes.has(child.type)) complexity++;
      });

      if (complexity > 10) {
        const nameNode = n.childForFieldName('name') || n.children.find(c => c.type === 'identifier');
        const name = nameNode ? nameNode.text : 'anonyme';
        errors.push({
          line: n.startPosition.row + 1,
          severity: 'warning',
          message: 'Complexité cyclomatique de "' + name + '" = ' + complexity + ' (seuil: 10)',
          fix: 'Décomposer en méthodes plus simples ou utiliser des design patterns',
          explanation: 'Complexité > 10 rend le code difficile à tester et maintenir.',
          source: 'ast'
        });
      }
    });
  }

  // ── Noms de variables trop courts (1-2 chars, hors i/j/k)
  _detectBadNames(node, lines, languageId, errors) {
    const varTypes = {
      java:       ['variable_declarator', 'formal_parameter'],
      javascript: ['variable_declarator', 'identifier'],
      typescript: ['variable_declarator', 'identifier'],
      python:     ['assignment', 'identifier']
    }[languageId] || [];

    const allowed = new Set(['i', 'j', 'k', 'x', 'y', 'z', 'e', 'n', 'id', '_']);
    const seen = new Set();

    this._walkNode(node, (n) => {
      if (!varTypes.includes(n.type)) return;
      const nameNode = n.childForFieldName('name') || (n.type === 'identifier' ? n : null);
      if (!nameNode) return;
      const name = nameNode.text;
      if (name.length <= 2 && !allowed.has(name) && !seen.has(name)) {
        seen.add(name);
        errors.push({
          line: nameNode.startPosition.row + 1,
          severity: 'info',
          message: 'Nom non descriptif : "' + name + '"',
          fix: 'Renommer avec un nom explicite décrivant le rôle de la variable',
          explanation: 'Les noms courts réduisent la lisibilité et la maintenabilité.',
          source: 'ast'
        });
      }
    });
  }

  // ── Duplication de blocs (lignes identiques répétées 3+ fois)
  _detectDuplication(lines, errors) {
    const blockSize = 4;
    const blocks = new Map();

    for (let i = 0; i <= lines.length - blockSize; i++) {
      const block = lines.slice(i, i + blockSize)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'))
        .join('\n');

      if (block.length < 50) continue; // trop court

      if (blocks.has(block)) {
        const firstLine = blocks.get(block);
        if (firstLine !== i) { // évite les doublons d'alerte
          errors.push({
            line: i + 1,
            severity: 'warning',
            message: 'Bloc dupliqué (ligne ' + (firstLine + 1) + ' et ligne ' + (i + 1) + ')',
            fix: 'Extraire ce bloc dans une méthode réutilisable (DRY principle)',
            explanation: 'La duplication de code augmente le risque d\'incohérences lors des modifications.',
            source: 'ast'
          });
        }
      } else {
        blocks.set(block, i);
      }
    }
  }

  // ── Imbrication profonde (> 4 niveaux)
  _detectDeepNesting(node, lines, errors) {
    const nestingNodes = new Set([
      'if_statement', 'for_statement', 'while_statement',
      'try_statement', 'switch_statement', 'block'
    ]);

    const checkNesting = (n, depth) => {
      if (nestingNodes.has(n.type)) depth++;
      if (depth > 4) {
        errors.push({
          line: n.startPosition.row + 1,
          severity: 'warning',
          message: 'Imbrication trop profonde (niveau ' + depth + ' > 4)',
          fix: 'Utiliser Early Return Pattern ou extraire des méthodes',
          explanation: 'L\'imbrication > 4 rend le code illisible et difficile à débugger.',
          source: 'ast'
        });
        return; // pas besoin d'aller plus loin
      }
      for (const child of n.children) {
        checkNesting(child, depth);
      }
    };

    checkNesting(node, 0);
  }

  // ── Parcours générique de l'AST
  _walkNode(node, callback) {
    callback(node);
    for (const child of node.children) {
      this._walkNode(child, callback);
    }
  }

  // ── Métriques résumées (pour le scoring)
  getMetrics(code, languageId) {
    const result = this.analyze(code, languageId);
    if (!result.astAvailable) return null;

    return {
      totalIssues:   result.errors.length,
      longFunctions: result.errors.filter(e => e.message.includes('longue')).length,
      highComplexity:result.errors.filter(e => e.message.includes('cyclomatique')).length,
      badNames:      result.errors.filter(e => e.message.includes('descriptif')).length,
      duplications:  result.errors.filter(e => e.message.includes('dupliqué')).length,
      deepNesting:   result.errors.filter(e => e.message.includes('Imbrication')).length,
      errors:        result.errors
    };
  }
}

module.exports = { ASTAnalyzer };