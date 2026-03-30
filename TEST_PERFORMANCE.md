# Test: Analyse de Performance

## Utilisation
- **Shortcut**: `Ctrl+Alt+F` (ou depuis la Command Palette: "AI: ⚡ Analyse performance")
- **Sidebar**: Bouton "⚡ Analyse Performance"

## Exemples de code détectés

### ❌ Boucles O(n²)
```javascript
// Problème: 20 pts de pénalité
for (let i = 0; i < items.length; i++) {
  for (let j = 0; j < items.length; j++) {
    if (items[i].id === items[j].id) {
      console.log('Trouvé');
    }
  }
}
```
**Explication**: Si 1000 items → 1M itérations! Utiliser un Map pour O(n).

### ❌ N+1 Queries
```javascript
// Problème: 20 pts de pénalité
users.forEach(user => {
  const posts = db.query(`SELECT * FROM posts WHERE user_id = ${user.id}`);
});
```
**Fix**: `SELECT * FROM posts WHERE user_id IN (...)` (une requête).

### ❌ String Concatenation en boucle
```javascript
// Problème: 10 pts de pénalité
let result = '';
for (let i = 0; i < 10000; i++) {
  result += i.toString();  // Crée une nouvelle string à chaque fois!
}
```
**Fix**: Utiliser `['string1', 'string2'].join('')` ou StringBuilder.

### ❌ Fuite Mémoire
```javascript
// Problème: 15 pts de pénalité
button.addEventListener('click', function() {
  // ...
});
// Jamais supprimé = mémoire bloquée
```
**Fix**: `button.removeEventListener('click', handler)` avant destruction.

### ❌ Récursion sans limite
```javascript
// Problème: 10 pts de pénalité
function factorial(n) {
  return n * factorial(n - 1);  // Pas de cas de base!
}
```
**Fix**: Ajouter `if (n <= 1) return 1;` avant la récursion.

### ✅ Code optimisé
```javascript
// Score: 95+
const userMap = new Map(users.map(u => [u.id, u]));
const found = userMap.get(userId);  // O(1) lookup

const userIds = users.map(u => u.id);
const posts = db.query(`SELECT * FROM posts WHERE user_id IN (?)`, [userIds]);

result = items.map(String).join('');  // Efficient string building
```

## Scoring
| Score | Interprétation |
|-------|-----------------|
| 95-100 | 🚀 Performance professionnelle |
| 80-94 | ⚡ Acceptable |
| 65-79 | ⚠️ À optimiser |
| 50-64 | 🔴 Problèmes sérieux |
| <50 | 💥 Critique |

## Après l'analyse

1. **Résultats** affichés dans la sidebar
2. **Diagnostics** montrés dans les marges de l'éditeur
3. **Toast** avec un résumé et actions possibles
4. **Bouton "Relancer ▶️"** pour ré-analyser après optimisation

Essayez maintenant sur vos fichiers! 🚀
