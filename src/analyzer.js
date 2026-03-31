const https = require('https');

// ══════════════════════════════════════════════
// CACHE GLOBAL — persiste toute la session VS Code
// Clé = type + langage + hash du code
// Même code = même résultat garanti
// ══════════════════════════════════════════════
const _cache = new Map();

function _hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

class AIAnalyzer {
  constructor(apiKey, language = 'fr') {
    this.apiKey = apiKey;
    this.language = language;
    this.conversationHistory = [];
  }

  async analyzeFile(code, language) {
    const key = 'analyze|' + language + '|' + _hash(code);
    if (_cache.has(key)) { console.log('[CACHE HIT] analyzeFile'); return _cache.get(key); }
    const prompt = 'Analyse ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```';
    const result = await this._callAPI(prompt);
    _cache.set(key, result);
    return result;
  }

  async analyzeSecurity(code, language) {
    const key = 'security|' + language + '|' + _hash(code);
    if (_cache.has(key)) { console.log('[CACHE HIT] analyzeSecurity'); return _cache.get(key); }
    const prompt = 'Analyse UNIQUEMENT les vulnérabilités de sécurité de ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```';
    const result = await this._callAPIWithSystemPrompt(prompt, 'security');
    _cache.set(key, result);
    return result;
  }

  async analyzePerformance(code, language) {
    const key = 'performance|' + language + '|' + _hash(code);
    if (_cache.has(key)) { console.log('[CACHE HIT] analyzePerformance'); return _cache.get(key); }
    const prompt = 'Analyse UNIQUEMENT la performance et l\'optimisation de ce code ' + language + ':\n\n```' + language + '\n' + code + '\n```\n\nDétecte: boucles O(n²), requêtes en boucles (N+1), fuites mémoire, récursion sans limite, string concatenation en boucle, événements non supprimés, race conditions.';
    const result = await this._callAPIWithSystemPrompt(prompt, 'performance');
    _cache.set(key, result);
    return result;
  }

  async analyzeDeadCode(code, language) {
    const key = 'deadcode|' + language + '|' + _hash(code);
    if (_cache.has(key)) { console.log('[CACHE HIT] analyzeDeadCode'); return _cache.get(key); }
    const prompt = 'Analyse ce code ' + language + ' et identifie UNIQUEMENT le code mort et inutilisé:\n\n```' + language + '\n' + code + '\n```';
    const result = await this._callAPIWithSystemPrompt(prompt, 'deadcode');
    _cache.set(key, result);
    return result;
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
    const filesContent = Object.entries(filesMap).slice(0, 8)
      .map(function(e) { return '### ' + e[0] + '\n```' + mainLanguage + '\n' + e[1].substring(0, 800) + '\n```'; })
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
  clearCache() {
  _cache.clear();
  console.log('[CACHE] Vidé');
}

  async _callAPIWithSystemPrompt(userMessage, type) {
    const systemPrompts = {
      security:    this._getSecurityPrompt(),
      deadcode:    this._getDeadCodePrompt(),
      performance: this._getPerformancePrompt(),
      project:     this._getProjectPrompt(),
      git:         this._getGitPrompt(),
      doc:         'Tu es un expert documentation. Réponds en JSON:\n{"errors":[],"summary":"<desc>","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code avec doc>"}',
      generate:    'Tu es un expert dev. Réponds en JSON:\n{"errors":[],"summary":"<explication>","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code généré>"}',
      completion:  'Tu es un assistant complétion. Réponds en JSON:\n{"errors":[],"summary":"","score":100,"scoreDetails":{"breakdown":[]},"advice":[],"refactored":"<code>"}'
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
    '  -10 pts : bug critique\n' +
    '  -8 pts  : exception non gérée\n' +
    '  -7 pts  : variable non initialisée\n' +
    '  -10 pts : boucle/récursion infinie\n' +
    '  -5 pts  : condition toujours vraie/fausse\n\n' +
    '【2. SÉCURITÉ (OWASP Top 10)】 max -25 pts\n' +
    '  -15 pts : SQL Injection\n' +
    '  -10 pts : XSS\n' +
    '  -15 pts : Credentials en dur\n' +
    '  -10 pts : Données sensibles non chiffrées\n' +
    '  -8 pts  : Entrées non validées\n\n' +
    '【3. CLEAN CODE】 max -20 pts\n' +
    '  -3 pts  : Noms non descriptifs (max -9)\n' +
    '  -5 pts  : Fonction > 30 lignes\n' +
    '  -5 pts  : Code dupliqué\n' +
    '  -3 pts  : Magic numbers\n' +
    '  -3 pts  : Commentaires manquants\n\n' +
    '【4. ARCHITECTURE & SOLID】 max -15 pts\n' +
    '  -5 pts  : Violation SRP\n' +
    '  -5 pts  : Couplage fort\n' +
    '  -5 pts  : Absence gestion erreurs\n' +
    '  -5 pts  : Complexité cyclomatique > 10\n\n' +
    '【5. PERFORMANCE】 max -10 pts\n' +
    '  -8 pts  : N+1 problem\n' +
    '  -3 pts  : String concat en boucle\n' +
    '  -5 pts  : Algorithme O(n²) évitable\n\n' +
    'RÈGLES ABSOLUES:\n' +
    '- Sans tests unitaires: score max = 85\n' +
    '- Sans documentation: score max = 90\n' +
    '- Avec secrets en dur: score max = 50\n' +
    '- DÉTERMINISME STRICT: score = exactement 100 - somme_des_déductions. Calcule chaque déduction explicitement. Pas d\'arrondi subjectif.\n' +
    '- DÉDUPLICATION STRICTE: Maximum 1 diagnostic par numéro de ligne. Regroupe TOUS les problèmes d\'une même ligne en UN SEUL objet dans "errors". Un message concis qui résume tous les problèmes de cette ligne.\n\n' +
    'Réponds UNIQUEMENT en JSON valide:\n' +
    '{\n' +
    '  "errors": [{"line":<n ou null>,"severity":"error|warning|info","message":"<problème concis — 1 seul par ligne>","fix":"<UNE SEULE LIGNE de code Java/JS exact prêt à copier-coller, JAMAIS une description textuelle. Exemple: .orElseThrow(() -> new NoSuchElementException(\\"Entry not found: \\" + entryId))>","explanation":"<pourquoi en 1 phrase>"}],\n' +
    '  "summary": "<résumé 2-3 phrases>",\n' +
    '  "score": <0-100>,\n' +
    '  "scoreDetails": {"breakdown": [\n' +
    '    {"critere":"Bugs & Correctness","note":<pts/40>,"max":40,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},\n' +
    '    {"critere":"Sécurité (OWASP)","note":<pts/25>,"max":25,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},\n' +
    '    {"critere":"Clean Code","note":<pts/20>,"max":20,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},\n' +
    '    {"critere":"Architecture & SOLID","note":<pts/15>,"max":15,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},\n' +
    '    {"critere":"Performance","note":<pts/10>,"max":10,"deduction":<perdus>,"detail":"<trouvé ou RAS>"}\n' +
    '  ]},\n' +
    '  "advice": ["<conseil 1>","<conseil 2>","<conseil 3>"],\n' +
    '  "refactored": null\n' +
    '}';
}

  _getSecurityPrompt() {
    return 'Tu es un expert cybersécurité (OWASP). Analyse UNIQUEMENT les vulnérabilités.\nRéponds en JSON:\n{"errors":[{"line":<n>,"severity":"error|warning|info","message":"<vuln>","fix":"<code exact de correction, une seule ligne>","explanation":"<explication>"}],"summary":"<résumé>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getDeadCodePrompt() {
    return 'Tu es un expert analyse statique. Identifie UNIQUEMENT le code mort (variables/fonctions/imports inutilisés, blocs inaccessibles).\nRéponds en JSON:\n{"errors":[{"line":<n>,"severity":"warning|info","message":"<desc>","fix":"// SUPPRIMER cette ligne: <nom>","explanation":"<pourquoi>"}],"summary":"<X éléments morts>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getProjectPrompt() {
    return 'Tu es un architecte logiciel senior. Analyse l\'architecture selon les standards industriels.\nRéponds en JSON:\n{"errors":[{"line":null,"severity":"error|warning|info","message":"<problème>","fix":"<solution>","explanation":"<détail>"}],"summary":"<analyse>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

  _getGitPrompt() {
    return 'Tu es un expert code review. Analyse ce diff selon les standards professionnels.\nRéponds en JSON:\n{"errors":[{"line":<n>,"severity":"error|warning|info","message":"<problème>","fix":"<code exact optimisé, une seule ligne>","explanation":"<explication>"}],"summary":"<résumé>","score":<0-100>,"scoreDetails":{"breakdown":[]},"advice":["<conseil>"],"refactored":null}';
  }

 _getPerformancePrompt() {
  return 'Tu es un expert performance et optimisation algorithmique.\n' +
    'SCORING sur 100 — DÉTERMINISME STRICT: score = exactement 100 - somme des déductions. Calcule chaque déduction explicitement avant de soustraire.\n\n' +
    'Déduis:\n' +
    '【Complexité algorithmique】 max -35 pts: O(n²) -20pts, O(n³) -25pts, récursion infinie -10pts, recherche linéaire en boucle -8pts\n' +
    '【Requêtes DB/IO】 max -25 pts: N+1 problem -20pts, appel API en boucle -15pts, lecture fichier en boucle -10pts\n' +
    '【Gestion mémoire】 max -20 pts: fuite mémoire -15pts, objets inutiles en boucle -10pts, cache sans limite -8pts\n' +
    '【String & Collections】 max -15 pts: concat string en boucle -10pts, copie inutile -5pts\n' +
    '【Concurrence & Async】 max -15 pts: race condition -15pts, callback hell -8pts, pas de timeout -5pts\n\n' +
    'RÈGLES ABSOLUES:\n' +
    '- DÉDUPLICATION STRICTE: Maximum 1 diagnostic par numéro de ligne. Regroupe TOUS les problèmes d\'une même ligne en UN SEUL objet dans "errors".\n' +
    '- Le champ "fix" doit contenir du CODE EXACT prêt à copier-coller, JAMAIS une description textuelle.\n\n' +
    'Réponds UNIQUEMENT en JSON valide:\n' +
    '{"errors":[{"line":<n ou null>,"severity":"error|warning|info","message":"<problème concis — 1 seul par ligne>","fix":"<code exact optimisé, une seule ligne>","explanation":"<impact perf en 1 phrase>"}],' +
    '"summary":"<résumé 2-3 phrases>",' +
    '"score":<0-100>,' +
    '"scoreDetails":{"breakdown":[' +
    '{"critere":"Complexité algorithmique","note":<pts/35>,"max":35,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},' +
    '{"critere":"Requêtes DB/IO","note":<pts/25>,"max":25,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},' +
    '{"critere":"Gestion mémoire","note":<pts/20>,"max":20,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},' +
    '{"critere":"String & Collections","note":<pts/15>,"max":15,"deduction":<perdus>,"detail":"<trouvé ou RAS>"},' +
    '{"critere":"Concurrence & Async","note":<pts/15>,"max":15,"deduction":<perdus>,"detail":"<trouvé ou RAS>"}]},' +
    '"advice":["<conseil 1>","<conseil 2>","<conseil 3>"],' +
    '"refactored":null}';
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
                setTimeout(function() {
                  this._httpRequest(body, retryCount + 1).then(resolve).catch(reject);
                }.bind(this), Math.min(parseFloat(retryMatch[1]) * 1000, 65000));
                return;
              }
              reject(new Error('Gemini API Error: ' + parsed.error.message));
              return;
            }
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
    // Étape 1 : nettoyer les backticks markdown
    let cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Étape 2 : réparer les erreurs JSON typiques de l'IA
    // Bug 1: explanation": sans guillemet ouvrant
    cleaned = cleaned.replace(/([,{\s])explanation":/g, '$1"explanation":');
    // Bug 2: virgules trailing avant } ou ]
    cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
    // Bug 3: propriétés sans guillemets ouvrants (pattern général)
    cleaned = cleaned.replace(/([,{\n\r]\s*)([a-zA-Z_]+)":/g, function(match, p1, p2) {
      return p1 + '"' + p2 + '":';
    });

    const parsed = JSON.parse(cleaned);
    parsed.rawText = rawText;
    return parsed;

  } catch (e) {
    // JSON irrécupérable → extraire par regex
    const scoreMatch  = rawText.match(/"score"\s*:\s*(\d+)/);
    const summaryMatch = rawText.match(/"summary"\s*:\s*"([^"]{0,300})"/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

    // Extraire les erreurs par regex aussi
    const errors = [];
    const errorBlocks = rawText.match(/"message"\s*:\s*"([^"]+)"/g) || [];
    const fixBlocks   = rawText.match(/"fix"\s*:\s*"([^"]+)"/g) || [];
    const lineBlocks  = rawText.match(/"line"\s*:\s*(\d+|null)/g) || [];

    errorBlocks.forEach(function(block, i) {
      const msg  = block.match(/"message"\s*:\s*"([^"]+)"/);
      const fix  = fixBlocks[i] ? fixBlocks[i].match(/"fix"\s*:\s*"([^"]+)"/) : null;
      const line = lineBlocks[i] ? lineBlocks[i].match(/(\d+)/) : null;
      if (msg) {
        errors.push({
          line: line ? parseInt(line[1]) : null,
          severity: 'warning',
          message: msg[1],
          fix: fix ? fix[1] : null,
          explanation: null
        });
      }
    });

    return {
      errors: errors,
      summary: summaryMatch ? summaryMatch[1] : 'Analyse terminée.',
      score: score,
      scoreDetails: null,
      advice: [],
      rawText: rawText
    };
  }
}
}
module.exports = { AIAnalyzer };