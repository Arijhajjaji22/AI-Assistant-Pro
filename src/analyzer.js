const https = require('https');

class AIAnalyzer {
  constructor(apiKey, language = 'fr') {
    this.apiKey = apiKey;
    this.language = language;
    this.conversationHistory = [];
  }

  async analyzeFile(code, language) {
    const prompt = 'Analyse ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```';
    return await this._callAPI(prompt);
  }

  async analyzeSecurity(code, language) {
    const prompt = 'Analyse UNIQUEMENT les vulnérabilités de sécurité de ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```';
    return await this._callAPIWithSystemPrompt(prompt, 'security');
  }

  async analyzePerformance(code, language) {
    const prompt = 'Analyse UNIQUEMENT la performance et l\'optimisation de ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```\n\nDétecte: boucles O(n²), requêtes en boucles (N+1), fuites mémoire, récursion sans limite, string concatenation en boucle, événements non supprimés, race conditions.';
    return await this._callAPIWithSystemPrompt(prompt, 'performance');
  }

  async analyzeDeadCode(code, language) {
    const prompt = 'Analyse ce code ' + language + ' et identifie UNIQUEMENT le code mort et inutilisé:\n\n```' + language + '\n' + code + '\n```';
    return await this._callAPIWithSystemPrompt(prompt, 'deadcode');
  }

  async generateDocumentation(code, language) {
    const prompt = 'Génère la documentation complète pour ce code ' + language + '. Retourne le code COMPLET avec documentation dans "refactored":\n\n```' + language + '\n' + code + '\n```';
    return await this._callAPIWithSystemPrompt(prompt, 'doc');
  }

  async generateCode(description, language, context) {
    const ctx = context ? 'Contexte:\n```' + language + '\n' + context + '\n```\n\n' : '';
    const prompt = ctx + 'Génère du code ' + language + ' pour: ' + description;
    return await this._callAPIWithSystemPrompt(prompt, 'generate');
  }

  async analyzeProject(filesMap, mainLanguage) {
    const filesContent = Object.entries(filesMap)
      .slice(0, 8)
      .map(function(entry) { return '### ' + entry[0] + '\n```' + mainLanguage + '\n' + entry[1].substring(0, 800) + '\n```'; })
      .join('\n\n');
    const prompt = 'Analyse l\'architecture de ce projet (' + Object.keys(filesMap).length + ' fichiers):\n\n' + filesContent;
    return await this._callAPIWithSystemPrompt(prompt, 'project');
  }

  async analyzeGitDiff(diff, language) {
    const prompt = 'Analyse ce diff Git:\n\n```diff\n' + diff + '\n```';
    return await this._callAPIWithSystemPrompt(prompt, 'git');
  }

  async explainCode(code, language) {
    const prompt = 'Explique ce code ' + language + ' en détail:\n\n```' + language + '\n' + code + '\n```';
    return await this._callAPI(prompt);
  }

  async refactorCode(code, language) {
    const prompt = 'Refactore ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```\n\nMets le code refactoré dans "refactored".';
    return await this._callAPI(prompt);
  }

  async getCompletion(prefix, suffix, language) {
    const prompt = 'Complete ce code ' + language + '.\nPRÉFIXE:\n```\n' + prefix.slice(-300) + '\n```\nSUFFIXE:\n```\n' + suffix.slice(0, 200) + '\n```';
    return await this._callAPIWithSystemPrompt(prompt, 'completion');
  }

  async chat(userMessage, currentCode, language, filePath) {
    const fileInfo = filePath ? 'Fichier: ' + filePath + '\n' : '';
    const messageWithContext = this.conversationHistory.length === 0
      ? 'Contexte - ' + fileInfo + 'langage: ' + language + '\n```' + language + '\n' + currentCode.substring(0, 2000) + '\n```\n\nQuestion: ' + userMessage
      : userMessage;
    this.conversationHistory.push({ role: 'user', parts: [{ text: messageWithContext }] });
    const response = await this._callAPIWithHistory();
    this.conversationHistory.push({ role: 'model', parts: [{ text: response.rawText || '' }] });
    return response;
  }

  clearHistory() { this.conversationHistory = []; }

  async _callAPIWithSystemPrompt(userMessage, type) {
    const systemPrompts = {
      security: this._getSecurityPrompt(),
      deadcode: this._getDeadCodePrompt(),
      doc: 'Tu es un expert documentation. Réponds en JSON:\n{"errors":[],"summary":"<desc>","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code avec doc>"}',
      generate: 'Tu es un expert dev. Réponds en JSON:\n{"errors":[],"summary":"<explication>","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code généré>"}',
      project: this._getProjectPrompt(),
      git: this._getGitPrompt(),
      performance: this._getPerformancePrompt(),
      completion: 'Tu es un assistant complétion. Réponds en JSON:\n{"errors":[],"summary":"","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code>"}'
    };
    const body = {
      system_instruction: { parts: [{ text: systemPrompts[type] || this._getDefaultSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }]
    };
    const rawText = await this._httpRequest(body);
    return this._parseResponse(rawText);
  }

  async _callAPI(userMessage) {
    const body = {
      system_instruction: { parts: [{ text: this._getDefaultSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }]
    };
    const rawText = await this._httpRequest(body);
    return this._parseResponse(rawText);
  }

  async _callAPIWithHistory() {
    const rawText = await this._httpRequest({ contents: this.conversationHistory });
    return this._parseResponse(rawText);
  }

  _getDefaultSystemPrompt() {
    return 'Tu es un expert senior développeur logiciel (niveau Google/Microsoft/Amazon).\n' +
    'Analyse le code selon les standards industriels reconnus mondialement.\n' +
    'Langages supportés: JavaScript, TypeScript, Python, Java, C, C++, Go, Rust, PHP, Ruby, HTML, CSS, SQL, JSON, YAML, Shell/Bash.\n\n' +
    '══════════════════════════════════════\n' +
    'SCORING PROFESSIONNEL STRICT — sur 100\n' +
    '══════════════════════════════════════\n' +
    'Commence à 100, déduis les points selon ces critères:\n\n' +
    '【1. BUGS & CORRECTNESS】 max -40 pts\n' +
    '  -10 pts : bug critique (NullPointer, ArrayIndexOutOfBounds, logique incorrecte)\n' +
    '  -8 pts  : exception non gérée pouvant crasher\n' +
    '  -7 pts  : variable non initialisée utilisée\n' +
    '  -10 pts : boucle/récursion infinie\n' +
    '  -5 pts  : condition toujours vraie/fausse\n\n' +
    '【2. SÉCURITÉ (OWASP Top 10)】 max -25 pts\n' +
    '  -15 pts : SQL Injection (requête non paramétrée)\n' +
    '  -10 pts : XSS (données user non échappées)\n' +
    '  -15 pts : Credentials/secrets en dur dans le code\n' +
    '  -10 pts : Données sensibles non chiffrées\n' +
    '  -8 pts  : Entrées utilisateur non validées\n' +
    '  -5 pts  : Path traversal possible\n\n' +
    '【3. CLEAN CODE (Robert C. Martin)】 max -20 pts\n' +
    '  -3 pts  : Noms non descriptifs (a, b, x, tmp, data, obj) — par occurrence (max -9)\n' +
    '  -5 pts  : Fonction > 30 lignes (Single Responsibility)\n' +
    '  -5 pts  : Classe > 200 lignes\n' +
    '  -5 pts  : Code dupliqué (DRY violation)\n' +
    '  -3 pts  : Magic numbers (utiliser des constantes nommées)\n' +
    '  -3 pts  : Commentaires manquants sur méthodes publiques\n' +
    '  -2 pts  : Else inutile après return (Early Return Pattern)\n\n' +
    '【4. ARCHITECTURE & SOLID】 max -15 pts\n' +
    '  -5 pts  : Violation SRP (classe fait trop de choses)\n' +
    '  -5 pts  : Couplage fort (dépendances directes entre classes)\n' +
    '  -5 pts  : Absence totale de gestion d\'erreurs\n' +
    '  -5 pts  : Complexité cyclomatique > 10\n' +
    '  -3 pts  : God class ou God method\n\n' +
    '【5. PERFORMANCE】 max -10 pts\n' +
    '  -8 pts  : Requête DB dans une boucle (N+1 problem)\n' +
    '  -3 pts  : String concatenation dans une boucle (utiliser StringBuilder/join)\n' +
    '  -3 pts  : Création d\'objets inutiles dans une boucle\n' +
    '  -5 pts  : Algorithme O(n²) ou pire évitable\n' +
    '  -3 pts  : Chargement de données non nécessaires\n\n' +
    'RÈGLES ABSOLUES:\n' +
    '- Sans tests unitaires: score max = 85\n' +
    '- Sans documentation des méthodes publiques: score max = 90\n' +
    '- Avec secrets en dur: score max = 50\n' +
    '- Sois STRICT. Ne surnotre pas. Un code sans défauts évidents mérite 88-92, pas 100.\n' +
    '- DÉTERMINISME : Le score est UNIQUEMENT la somme arithmétique 100 - déductions. Ne jamais arrondir ni ajuster subjectivement. Calcule chaque déduction explicitement puis fais la soustraction. Le même code doit toujours donner le même score.\n\n' +
    'Réponds UNIQUEMENT en JSON valide, aucun texte avant ou après:\n' +
    '{\n' +
    '  "errors": [\n' +
    '    {\n' +
    '      "line": <numéro ou null>,\n' +
    '      "severity": "error|warning|info",\n' +
    '      "message": "<problème précis>",\n' +
    '      "fix": "<correction concrète>",\n' +
    '      "explanation": "<pourquoi cest un problème>"\n' +
    '    }\n' +
    '  ],\n' +
    '  "summary": "<résumé global en 2-3 phrases>",\n' +
    '  "score": <note 0-100>,\n' +
    '  "scoreDetails": {\n' +
    '    "breakdown": [\n' +
    '      { "critere": "Bugs & Correctness", "note": <pts/40>, "max": 40, "deduction": <pts perdus>, "detail": "<trouvé ou RAS>"},\n' +
    '      { "critere": "Sécurité (OWASP)", "note": <pts/25>, "max": 25, "deduction": <pts perdus>, "detail": "<trouvé ou RAS>"},\n' +
    '      { "critere": "Clean Code", "note": <pts/20>, "max": 20, "deduction": <pts perdus>, "detail": "<trouvé ou RAS>"},\n' +
    '      { "critere": "Architecture & SOLID", "note": <pts/15>, "max": 15, "deduction": <pts perdus>, "detail": "<trouvé ou RAS>"},\n' +
    '      { "critere": "Performance", "note": <pts/10>, "max": 10, "deduction": <pts perdus>, "detail": "<trouvé ou RAS>"}\n' +
    '    ]\n' +
    '  },\n' +
    '  "advice": ["<conseil 1>", "<conseil 2>", "<conseil 3>"],\n' +
    '  "refactored": null\n' +
    '}';
  }

  _getSecurityPrompt() {
    return 'Tu es un expert cybersécurité (OWASP, CVE). Analyse UNIQUEMENT les vulnérabilités.\n' +
      'Réponds en JSON:\n{"errors":[{"line":<n>,"severity":"error|warning|info","message":"<vuln>","fix":"<fix>","explanation":"<explication>"}],' +
      '"summary":"<résumé>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getDeadCodePrompt() {
    return 'Tu es un expert analyse statique de code. Identifie UNIQUEMENT:\n' +
      '- Variables déclarées mais jamais utilisées\n' +
      '- Fonctions/méthodes définies mais jamais appelées\n' +
      '- Imports/require jamais utilisés\n' +
      '- Blocs de code inaccessibles (après return, throw, etc.)\n' +
      '- Conditions toujours vraies ou toujours fausses\n' +
      '- Paramètres de fonction jamais utilisés\n' +
      '- Branches else/catch jamais atteintes\n\n' +
      'Pour chaque élément trouvé, indique: nom, ligne, type (variable/fonction/import/bloc), et si on peut le supprimer en toute sécurité.\n\n' +
      'Réponds en JSON:\n' +
      '{"errors":[{"line":<n>,"severity":"warning|info","message":"<description>","fix":"Supprimer: <nom>","explanation":"<pourquoi cest du code mort>"}],' +
      '"summary":"<résumé: X éléments morts trouvés>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getProjectPrompt() {
    return 'Tu es un architecte logiciel senior. Analyse l\'architecture selon les standards industriels.\n' +
      'Réponds en JSON:\n{"errors":[{"line":null,"severity":"error|warning|info","message":"<problème>","fix":"<solution>","explanation":"<détail>"}],' +
      '"summary":"<analyse>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getGitPrompt() {
    return 'Tu es un expert code review. Analyse ce diff selon les standards professionnels.\n' +
      'Réponds en JSON:\n{"errors":[{"line":<n>,"severity":"error|warning|info","message":"<problème>","fix":"<correction>","explanation":"<explication>"}],' +
      '"summary":"<résumé>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getPerformancePrompt() {
    return 'Tu es un expert performance et optimisation algorithmique.\n' +
      'Analyse ce code et retourne un JSON avec un breakdown COMPLET obligatoire.\n\n' +
      'SCORING sur 100 — commence à 100, déduis:\n' +
      '【Complexité algorithmique】 max -35 pts: O(n²) -20pts, O(n³) -25pts, récursion infinie -10pts, recherche linéaire en boucle -8pts\n' +
      '【Requêtes DB/IO】 max -25 pts: N+1 problem -20pts, appel API en boucle -15pts, lecture fichier en boucle -10pts\n' +
      '【Gestion mémoire】 max -20 pts: fuite mémoire (event non supprimé) -15pts, objets inutiles en boucle -10pts, cache sans limite -8pts\n' +
      '【String & Collections】 max -15 pts: concaténation string en boucle -10pts, copie inutile -5pts\n' +
      '【Concurrence & Async】 max -15 pts: race condition -15pts, callback hell -8pts, pas de timeout -5pts\n\n' +
      'RÈGLE DÉTERMINISME: score = 100 - somme des déductions. Calcule chaque déduction explicitement.\n\n' +
      'Réponds UNIQUEMENT en JSON valide:\n' +
      '{\n' +
      '  "errors": [{"line":<n ou null>,"severity":"error|warning|info","message":"<problème>","fix":"<optimisation>","explanation":"<impact perf>"}],\n' +
      '  "summary": "<résumé 2-3 phrases>",\n' +
      '  "score": <0-100>,\n' +
      '  "scoreDetails": {\n' +
      '    "breakdown": [\n' +
      '      {"critere":"Complexité algorithmique","note":<pts/35>,"max":35,"deduction":<pts perdus>,"detail":"<trouvé ou RAS>"},\n' +
      '      {"critere":"Requêtes DB/IO","note":<pts/25>,"max":25,"deduction":<pts perdus>,"detail":"<trouvé ou RAS>"},\n' +
      '      {"critere":"Gestion mémoire","note":<pts/20>,"max":20,"deduction":<pts perdus>,"detail":"<trouvé ou RAS>"},\n' +
      '      {"critere":"String & Collections","note":<pts/15>,"max":15,"deduction":<pts perdus>,"detail":"<trouvé ou RAS>"},\n' +
      '      {"critere":"Concurrence & Async","note":<pts/15>,"max":15,"deduction":<pts perdus>,"detail":"<trouvé ou RAS>"}\n' +
      '    ]\n' +
      '  },\n' +
      '  "advice": ["<conseil 1>","<conseil 2>","<conseil 3>"],\n' +
      '  "refactored": null\n' +
      '}';
  }

  _httpRequest(body, retryCount) {
    retryCount = retryCount || 0;
    return new Promise(function(resolve, reject) {
      const bodyString = JSON.stringify(body);
      const model = 'gemini-2.5-flash-lite';
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: '/v1beta/models/' + model + ':generateContent?key=' + this.apiKey,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyString) }
      };
      const req = https.request(options, function(res) {
        let data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              const msg = parsed.error.message || '';
              const retryMatch = msg.match(/retry in ([\d.]+)s/i);
              if (retryMatch && retryCount < 2) {
                const waitMs = Math.min(parseFloat(retryMatch[1]) * 1000, 65000);
                setTimeout(function() {
                  this._httpRequest(body, retryCount + 1).then(resolve).catch(reject);
                }.bind(this), waitMs);
                return;
              }
              reject(new Error('Gemini API Error: ' + parsed.error.message));
              return;
            }
            const text = parsed.candidates && parsed.candidates[0] &&
              parsed.candidates[0].content && parsed.candidates[0].content.parts &&
              parsed.candidates[0].content.parts[0] ? parsed.candidates[0].content.parts[0].text : '';
            resolve(text);
          } catch (e) { reject(new Error('Erreur parsing: ' + e.message)); }
        }.bind(this));
      }.bind(this));
      req.on('error', function(e) { reject(new Error('Erreur réseau: ' + e.message)); });
      req.setTimeout(90000, function() { req.destroy(); reject(new Error('Timeout 90s')); });
      req.write(bodyString);
      req.end();
    }.bind(this));
  }

  _parseResponse(rawText) {
    try {
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      parsed.rawText = rawText;
      return parsed;
    } catch (e) {
      return { errors: [{ line: null, severity: 'info', message: 'Réponse IA', fix: null, explanation: rawText }], summary: rawText, score: null, scoreDetails: null, advice: [], rawText: rawText };
    }
  }
}

module.exports = { AIAnalyzer };