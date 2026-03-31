/**
 * securityScanner.js — Sécurité avancée
 * Combine Snyk API (vulnérabilités CVE réelles) +
 * patterns OWASP locaux (pas besoin d'API pour les basiques)
 */

const https = require('https');

// ── Patterns OWASP locaux — détection instantanée sans API
const OWASP_PATTERNS = [
  {
    id: 'A01-SQL-INJECTION',
    pattern: /query\s*\(\s*["'`][^"'`]*\+|execute\s*\(\s*["'`][^"'`]*\+|createQuery\s*\(\s*["'`][^"'`]*\+/gi,
    severity: 'error',
    message: 'SQL Injection — requête non paramétrée détectée',
    fix: 'Utiliser des PreparedStatement ou requêtes paramétrées (@Query avec :param)',
    cve: 'OWASP A01:2021'
  },
  {
    id: 'A02-HARDCODED-SECRET',
    pattern: /(password|secret|apikey|api_key|token|passwd)\s*=\s*["'][^"']{4,}["']/gi,
    severity: 'error',
    message: 'Credentials en dur dans le code',
    fix: 'Utiliser des variables d\'environnement ou un vault (Spring @Value, process.env)',
    cve: 'OWASP A02:2021'
  },
  {
    id: 'A03-XSS',
    pattern: /innerHTML\s*=|document\.write\s*\(|eval\s*\(/gi,
    severity: 'error',
    message: 'XSS potentiel — insertion HTML non échappée',
    fix: 'Utiliser textContent au lieu de innerHTML, ou échapper les données',
    cve: 'OWASP A03:2021'
  },
  {
    id: 'A05-SECURITY-MISCONFIGURATION',
    pattern: /cors\s*\(\s*\{[^}]*origin\s*:\s*['"]\*['"]/gi,
    severity: 'warning',
    message: 'CORS trop permissif (origin: *)',
    fix: 'Restreindre les origines CORS aux domaines autorisés',
    cve: 'OWASP A05:2021'
  },
  {
    id: 'A06-VULNERABLE-COMPONENT',
    pattern: /md5\s*\(|SHA1\s*\(|DES\s*\(/gi,
    severity: 'error',
    message: 'Algorithme cryptographique obsolète (MD5/SHA1/DES)',
    fix: 'Utiliser SHA-256, AES-256 ou bcrypt pour les mots de passe',
    cve: 'OWASP A06:2021'
  },
  {
    id: 'A07-AUTH-FAILURE',
    pattern: /\.permitAll\(\)|authenticated\s*=\s*false|@PreAuthorize\s*\(\s*["']permitAll/gi,
    severity: 'warning',
    message: 'Endpoint potentiellement non sécurisé',
    fix: 'Vérifier que cet endpoint ne nécessite pas d\'authentification',
    cve: 'OWASP A07:2021'
  },
  {
    id: 'A08-INTEGRITY',
    pattern: /deserializ|ObjectInputStream|pickle\.loads/gi,
    severity: 'warning',
    message: 'Désérialisation non sécurisée détectée',
    fix: 'Valider les données avant désérialisation, utiliser JSON plutôt que sérialisation Java',
    cve: 'OWASP A08:2021'
  },
  {
    id: 'A10-SSRF',
    pattern: /new\s+URL\s*\(\s*req\.|fetch\s*\(\s*req\.|HttpClient.*req\./gi,
    severity: 'error',
    message: 'SSRF potentiel — URL construite depuis input utilisateur',
    fix: 'Valider et whitelist les URLs avant d\'effectuer des requêtes HTTP',
    cve: 'OWASP A10:2021'
  }
];

class SecurityScanner {
  constructor(snykToken) {
    this.snykToken = snykToken || null;
  }

  // ── Analyse locale OWASP (instantanée, sans API)
  scanLocal(code, languageId) {
    const lines = code.split('\n');
    const errors = [];
    const seen = new Set();

    OWASP_PATTERNS.forEach(function(rule) {
      const matches = [...code.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))];
      matches.forEach(function(match) {
        // Trouver le numéro de ligne
        const pos = match.index;
        let lineNum = 1;
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1;
          if (charCount > pos) { lineNum = i + 1; break; }
        }

        const key = rule.id + ':' + lineNum;
        if (seen.has(key)) return;
        seen.add(key);

        errors.push({
          line: lineNum,
          severity: rule.severity,
          message: '[' + rule.cve + '] ' + rule.message,
          fix: rule.fix,
          explanation: 'Référence: ' + rule.cve + ' — ' + rule.message,
          source: 'owasp'
        });
      });
    });

    return errors;
  }

  // ── Snyk API — scan des dépendances (package.json / pom.xml)
  async scanDependencies(manifestContent, manifestType) {
    if (!this.snykToken) {
      return { errors: [], message: 'Snyk token non configuré — scan local OWASP uniquement' };
    }

    try {
      const payload = {
        encoding: 'plain',
        files: { target: { contents: manifestContent } }
      };

      const endpoint = manifestType === 'maven'
        ? '/v1/test/maven'
        : '/v1/test/npm';

      const result = await this._snykRequest(endpoint, payload);
      return this._parseSnykResult(result);
    } catch (e) {
      console.error('[Snyk]', e.message);
      return { errors: [], message: 'Snyk API error: ' + e.message };
    }
  }

  _parseSnykResult(result) {
    if (!result.issues) return { errors: [] };
    const errors = [];

    (result.issues.vulnerabilities || []).forEach(function(vuln) {
      errors.push({
        line: null,
        severity: vuln.severity === 'high' || vuln.severity === 'critical' ? 'error' : 'warning',
        message: '[CVE ' + (vuln.identifiers?.CVE?.[0] || vuln.id) + '] ' + vuln.title + ' in ' + vuln.packageName + '@' + vuln.version,
        fix: 'Mettre à jour vers ' + (vuln.fixedIn?.[0] || 'version corrigée'),
        explanation: vuln.description?.substring(0, 150) || '',
        source: 'snyk'
      });
    });

    return { errors };
  }

  _snykRequest(path, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const options = {
        hostname: 'snyk.io',
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'token ' + this.snykToken,
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Snyk parse error: ' + e.message)); }
        });
      });
      req.on('error', e => reject(e));
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Snyk timeout')); });
      req.write(bodyStr);
      req.end();
    });
  }

  // ── Score de sécurité basé sur les findings
  calculateSecurityScore(errors) {
    let score = 100;
    errors.forEach(e => {
      if (e.severity === 'error')   score -= 15;
      if (e.severity === 'warning') score -= 5;
    });
    return Math.max(0, score);
  }
}

module.exports = { SecurityScanner };