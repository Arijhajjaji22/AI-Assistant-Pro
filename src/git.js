const { execSync } = require('child_process');
const path = require('path');

class GitManager {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
  }

  isGitRepo() {
    let dir = this.workspacePath;
    const maxDepth = 5;
    let depth = 0;

    while (dir && depth < maxDepth) {
      try {
        const result = execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
        if (result === 'true') {
          this.workspacePath = dir;
          return true;
        }
      } catch (_) {}

      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
      depth += 1;
    }

    return false;
  }

  // Diff des fichiers modifiés (non commités)
  getStagedDiff() {
    try {
      return execSync('git diff --cached', { cwd: this.workspacePath, encoding: 'utf8' });
    } catch (e) {
      return '';
    }
  }

  getUnstagedDiff() {
    try {
      return execSync('git diff', { cwd: this.workspacePath, encoding: 'utf8' });
    } catch (e) {
      return '';
    }
  }

  getLastCommitDiff() {
    try {
      return execSync('git diff HEAD~1 HEAD', { cwd: this.workspacePath, encoding: 'utf8' });
    } catch (e) {
      return '';
    }
  }

  getStatus() {
    try {
      const status = execSync('git status --short', { cwd: this.workspacePath, encoding: 'utf8' });
      const branch = execSync('git branch --show-current', { cwd: this.workspacePath, encoding: 'utf8' }).trim();
      const log = execSync('git log --oneline -5', { cwd: this.workspacePath, encoding: 'utf8' });
      return { status: status.trim(), branch, log: log.trim() };
    } catch (e) {
      return { status: '', branch: 'unknown', log: '' };
    }
  }

  getChangedFiles() {
    try {
      const output = execSync('git diff --name-only', { cwd: this.workspacePath, encoding: 'utf8' });
      return output.trim().split('\n').filter(function(f) { return f.length > 0; });
    } catch (e) {
      return [];
    }
  }

  // Lire le contenu de plusieurs fichiers du projet
getProjectFiles(extensions, maxFiles) {
  const fs = require('fs');
  const result = {};
  maxFiles = maxFiles || 10;
  const self = this;  // ✅ Capturer la référence

  function walk(dir, depth) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || 
            entry === 'target' || entry === 'build' || entry === 'dist') continue;
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else {
          const ext = path.extname(entry).slice(1);
          if (extensions.includes(ext) && Object.keys(result).length < maxFiles) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const relPath = path.relative(self.workspacePath, fullPath);  // ✅ self
              result[relPath] = content;
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  walk(this.workspacePath, 0);
  return result;
}
}

module.exports = { GitManager };