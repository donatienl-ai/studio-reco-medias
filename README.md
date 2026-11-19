# Studio reco médias OpenMedias, version Render

Ce dossier fait tourner le Studio reco médias en dehors de claude.ai, sur un lien que n'importe qui peut ouvrir.

Sur claude.ai, la page s'appuie sur cinq fonctions fournies par Claude. Ici, un petit serveur les remplace, sans modifier la page :

| Fonction de la page | Sur claude.ai | Sur Render |
|---|---|---|
| Notes, arguments et textes de la reco | Claude de l'utilisateur connecté | API Anthropic, avec la clé d'OpenMedias (`ANTHROPIC_API_KEY`) |
| Téléchargement du PDF | Boîte de dialogue claude.ai | Téléchargement direct par le navigateur |
| Dispositifs modifiés dans l'administration | Stockage partagé de la page | Base Postgres Render |
| Fichiers de médias importés | Fichiers de la page | Base Postgres Render |
| Accès à l'administration | Propriétaire et éditeurs de la page | Mot de passe `ADMIN_PASSWORD` sur `/admin` |

Le fichier `public/claude-shim.js` est injecté automatiquement dans la page : il fournit `window.claude` et redirige chaque appel vers le serveur.

## Mise en ligne

1. **Récupérer la page.** Téléchargez le fichier HTML du Studio reco médias depuis claude.ai (environ 1 Mo, la base médias y est intégrée). Ne le modifiez pas.
2. **Créer le dépôt.** Mettez ce dossier dans un dépôt GitHub, GitLab ou Bitbucket (sans `node_modules`).
3. **Créer les services.** Sur Render : *New > Blueprint*, choisissez le dépôt. Render lit `render.yaml` et crée le service web et la base Postgres (région Francfort). Renseignez :
   - `ANTHROPIC_API_KEY` : une clé de console.anthropic.com, sur le compte qui paiera les appels ;
   - `ADMIN_PASSWORD` : le mot de passe de l'administration ;
   - `SITE_PASSWORD` : laissez vide pour un lien public, ou indiquez un mot de passe commun à l'équipe.
4. **Installer la page.** Ouvrez `https://<votre-service>.onrender.com/admin`, connectez-vous, déposez le fichier HTML, puis cliquez sur « Installer cette version ».
5. **Partager** `https://<votre-service>.onrender.com`.

Pour publier une nouvelle version de la page plus tard, refaites l'étape 4 : aucun redéploiement n'est nécessaire. Vous pouvez aussi placer le fichier dans `public/index.html` du dépôt. Une page déposée depuis `/admin` reste prioritaire.

## À savoir

- **Coût de l'API.** Chaque génération fait trois appels à Claude, plus un appel par « Réécrire les textes » et par média ajouté à la main. Avec un lien public, toute personne qui a le lien consomme les crédits de la clé. Deux protections :
  - `SAMPLE_RATE_LIMIT` limite les appels par adresse IP et par heure (60 par défaut) ;
  - `SITE_PASSWORD` réserve l'accès à l'équipe. C'est recommandé si le lien peut circuler.
- **Modèles.** `CLAUDE_MODEL` sert aux notes et aux textes, `CLAUDE_MODEL_QUICK` à la lecture du brief. Vérifiez les identifiants en vigueur sur la page des modèles Anthropic et changez-les dans Render si besoin.
- **Offre Render.**
  - Le service web gratuit se met en veille après 15 minutes sans visite : le premier chargement prend alors environ une minute. L'offre *Starter* évite cette attente.
  - La base gratuite est supprimée au bout de 30 jours. C'est pourquoi `render.yaml` prévoit l'offre payante d'entrée de gamme.
- **Sans base Postgres.** Sans `DATABASE_URL`, le serveur stocke les données dans des fichiers (`DATA_DIR`, par défaut `./data`). Sur Render, ces fichiers sont effacés à chaque redéploiement, sauf si un disque persistant est attaché.
- **Données de claude.ai.** Le stockage partagé de la page sur claude.ai ne contient aucun dispositif modifié ni aucune source importée : il n'y a rien à transférer.
- **Brouillons.** Ils restent enregistrés dans le navigateur de chaque utilisateur, comme sur claude.ai.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ANTHROPIC_API_KEY` | Clé API Anthropic | obligatoire pour les textes |
| `ADMIN_PASSWORD` | Mot de passe de `/admin` | sans elle, pas d'administration |
| `SITE_PASSWORD` | Mot de passe d'accès au studio | vide = public |
| `DATABASE_URL` | Base Postgres | fichiers locaux |
| `CLAUDE_MODEL` / `CLAUDE_MODEL_QUICK` | Modèles utilisés | `claude-sonnet-5` / `claude-haiku-4-5` |
| `CLAUDE_MAX_TOKENS` | Longueur maximale d'une réponse | 8000 |
| `SAMPLE_RATE_LIMIT` | Appels à Claude par IP et par heure | 60 |
| `SESSION_SECRET` | Signature de la session administrateur | générée par Render |
| `PGSSL` | `on` ou `off` pour forcer le SSL Postgres | automatique |

## Essai en local

```bash
npm install
cp .env.example .env   # puis remplir
node --env-file=.env server.js
# http://localhost:3000/admin pour installer la page
```
