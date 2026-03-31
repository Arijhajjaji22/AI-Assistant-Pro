/**
 * gitManager.js — Gestion Git avancée
 * Auto-commit sur branche ai-fix/timestamp,
 * propose PR, garde historique des corrections IA
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class GitManager {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this._gitAvailable = this._checkGit();
  }

  _checkGit() {
    try {
      execSync('git --version', { stdio: 'pipe' });
      return true;
    } catch (_) { return false; }
  }

  isGitRepo() {
    if (!this._gitAvailable) return false;
    try {
      execSync('git rev-parse --git-dir', { cwd: this.workspacePath, stdio: 'pipe' });
      return true;
    } catch (_) { return false; }
  }

  getCurrentBranch() {
    try {
      return execSync('git branch --show-current', { cwd: this.workspacePath, encoding: 'utf8' }).trim();
    } catch (_) { return 'unknown'; }
  }

  // ── Crée une branche ai-fix/timestamp et commit les corrections
  async createFixBranch(filePath, fixDescription, originalCode, fixedCode) {
    if (!this.isGitRepo()) throw new Error('Pas un dépôt Git');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const branchName = 'ai-fix/' + timestamp;
    const originalBranch = this.getCurrentBranch();

    try {
      // 1. Créer et basculer sur la branche fix
      this._exec('git checkout -b ' + branchName);

      // 2. Écrire le fichier corrigé
      fs.writeFileSync(filePath, fixedCode, 'utf8');

      // 3. Stager le fichier
      this._exec('git add "' + path.relative(this.workspacePath, filePath) + '"');

      // 4. Créer le commit avec message structuré
      const commitMsg = '🤖 AI Fix: ' + fixDescription + '\n\n' +
        'Automated fix by AI Code Assistant Pro\n' +
        'File: ' + path.basename(filePath) + '\n' +
        'Branch: ' + branchName;

      this._execWithInput('git commit -m', commitMsg);

      return {
        success: true,
        branch: branchName,
        originalBranch,
        message: 'Fix commité sur branche ' + branchName
      };
    } catch (err) {
      // Rollback sur la branche originale en cas d'erreur
      try { this._exec('git checkout ' + originalBranch); } catch (_) {}
      throw new Error('Git fix branch error: ' + err.message);
    }
  }

  // ── Merge la branche fix dans la branche courante
  mergeFixBranch(fixBranch) {
    if (!this.isGitRepo()) throw new Error('Pas un dépôt Git');
    try {
      this._exec('git merge --no-ff ' + fixBranch + ' -m "Merge AI fix from ' + fixBranch + '"');
      this._exec('git branch -d ' + fixBranch);
      return { success: true, message: 'Fix mergé et branche supprimée' };
    } catch (err) {
      throw new Error('Merge error: ' + err.message);
    }
  }

  // ── Annuler le fix (revenir sur la branche originale)
  rejectFix(fixBranch, originalBranch) {
    try {
      this._exec('git checkout ' + originalBranch);
      this._exec('git branch -D ' + fixBranch);
      return { success: true };
    } catch (err) {
      throw new Error('Reject error: ' + err.message);
    }
  }

  // ── Lister les branches ai-fix disponibles
  listFixBranches() {
    try {
      const output = execSync('git branch', { cwd: this.workspacePath, encoding: 'utf8' });
      return output.split('\n')
        .map(b => b.trim().replace(/^\* /, ''))
        .filter(b => b.startsWith('ai-fix/'));
    } catch (_) { return []; }
  }

  // ── Diff entre deux branches
  getDiffBetweenBranches(branch1, branch2) {
    try {
      return execSync('git diff ' + branch1 + '..' + branch2,
        { cwd: this.workspacePath, encoding: 'utf8' });
    } catch (_) { return ''; }
  }

  // ── Status, diff, log (pour la sidebar)
  getStatus() {
    try {
      const status = execSync('git status --short', { cwd: this.workspacePath, encoding: 'utf8' });
      const branch = this.getCurrentBranch();
      const log    = execSync('git log --oneline -5', { cwd: this.workspacePath, encoding: 'utf8' });
      return { status: status.trim(), branch, log: log.trim() };
    } catch (_) { return { status: '', branch: 'unknown', log: '' }; }
  }

  getStagedDiff()   { return this._safeExec('git diff --cached'); }
  getUnstagedDiff() { return this._safeExec('git diff'); }
  getLastCommitDiff() { return this._safeExec('git diff HEAD~1 HEAD'); }

  getChangedFiles() {
    const output = this._safeExec('git diff --name-only');
    return output.trim().split('\n').filter(f => f.length > 0);
  }

  // ── Lire les fichiers du projet (pour analyzeProject)
  getProjectFiles(extensions, maxFiles = 10) {
    const result = {};
    const walk = (dir, depth) => {
      if (depth > 3 || Object.keys(result).length >= maxFiles) return;
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (['.', 'node_modules', 'target', 'build', 'dist', '.git'].some(s => entry.startsWith(s))) continue;
          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else {
            const ext = path.extname(entry).slice(1);
            if (extensions.includes(ext) && Object.keys(result).length < maxFiles) {
              try { result[entry] = fs.readFileSync(fullPath, 'utf8'); } catch (_) {}
            }
          }
        }
      } catch (_) {}
    };
    walk(this.workspacePath, 0);
    return result;
  }

  _exec(cmd) {
    return execSync(cmd, { cwd: this.workspacePath, encoding: 'utf8', stdio: 'pipe' });
  }

  _safeExec(cmd) {
    try { return this._exec(cmd); } catch (_) { return ''; }
  }

  _execWithInput(cmd, input) {
    // Écrit le message dans un fichier temp pour éviter les problèmes d'échappement
    const tmpFile = path.join(this.workspacePath, '.git', 'AI_COMMIT_MSG');
    fs.writeFileSync(tmpFile, input, 'utf8');
    try {
      execSync('git commit -F "' + tmpFile + '"', { cwd: this.workspacePath, encoding: 'utf8', stdio: 'pipe' });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}

module.exports = { GitManager };