import { readFileSync, writeFileSync } from 'node:fs';
const { headers } = JSON.parse(readFileSync('vercel.json', 'utf8'));
writeFileSync('dist/vercel.json', JSON.stringify({ headers }, null, 2));
console.log('Dossier dist prêt pour un déploiement statique Vercel. Aucun fichier .env inclus.');
