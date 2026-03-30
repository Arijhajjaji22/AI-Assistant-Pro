// EXEMPLE: Code avec problèmes de performance
// Utilisez Ctrl+Alt+F pour analyser!

class DataProcessor {
  constructor(data) {
    this.data = data;
    this.cache = [];
    this.listeners = [];
  }

  // ❌ PROBLÈME 1: O(n²) - Boucles imbriquées
  findDuplicates(arr) {
    const duplicates = [];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[i].id === arr[j].id) {
          duplicates.push(arr[i]);
        }
      }
    }
    return duplicates;
  }

  // ❌ PROBLÈME 2: N+1 Queries
  loadUserPosts(userIds) {
    const allPosts = [];
    userIds.forEach(userId => {
      // Requête par utilisateur au lieu d'une requête unique!
      const posts = this.database.query(
        `SELECT * FROM posts WHERE user_id = ${userId}`
      );
      allPosts.push(...posts);
    });
    return allPosts;
  }

  // ❌ PROBLÈME 3: String concatenation en boucle
  buildCsv(records) {
    let csv = '';
    for (let i = 0; i < records.length; i++) {
      csv += records[i].name + ',' + records[i].email + '\n';
    }
    return csv;
  }

  // ❌ PROBLÈME 4: Fuite mémoire - événements non supprimés
  setupEventListener() {
    const listener = () => {
      console.log('Event fired');
      this.cache.push(new Date());  // Accumule sans limite!
    };
    window.addEventListener('click', listener);
    // Jamais supprimé!
  }

  // ❌ PROBLÈME 5: Récursion sans limite
  processRecursively(data, depth = 0) {
    if (data.children) {
      data.children.forEach(child => {
        this.processRecursively(child, depth + 1);
      });
    }
  }

  // ❌ PROBLÈME 6: Création d'objets en boucle
  processItems(items) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const config = { // Créé 1000x si items.length = 1000
        id: item.id,
        name: item.name,
        timestamp: new Date(),
        metadata: { ...item }  // Deep clone à chaque fois!
      };
      results.push(config);
    }
    return results;
  }

  // ✅ VERSION OPTIMISÉE
  findDuplicatesOptimized(arr) {
    const seen = new Map();
    const duplicates = [];
    arr.forEach(item => {
      if (seen.has(item.id)) {
        duplicates.push(item);
      }
      seen.set(item.id, true);
    });
    return duplicates; // O(n) au lieu de O(n²)
  }

  loadUserPostsOptimized(userIds) {
    // Une seule requête
    const posts = this.database.query(
      `SELECT * FROM posts WHERE user_id IN (?)`,
      [userIds]
    );
    return posts;
  }

  buildCsvOptimized(records) {
    return records
      .map(r => `${r.name},${r.email}`)
      .join('\n'); // Efficient
  }
}

// Lance l'analyse avec Ctrl+Alt+F pour voir tous les problèmes détectés!
module.exports = DataProcessor;
