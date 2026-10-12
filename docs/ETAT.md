# État d'avancement d'Ant

Ce document dit ce qui est fait, comment c'est vérifié, et ce qui reste limité. Il est mis à jour à chaque livraison.

## Résumé par phase

| Phase | Contenu | État |
|---|---|---|
| 1 | Authentification (mot de passe argon2id + TOTP, passkeys, codes de secours, limitation des tentatives, sessions), bots, messages privés, connexion abonnement + repli API, quota et budget | ✅ |
| 2 | Plusieurs bots, canaux de groupe, fils, @mentions, transferts avec garde-fous anti-boucle, recherche plein texte, mémoire partagée / par bot, compactage des longues sessions | ✅ |
| 3 | Ordinateur des agents (terminal, fichiers, Chromium persistant), vue en direct (noVNC + terminal), prise de main, validations exécutées à l'identique, isolation réseau | ✅ |
| 4 | Heartbeat à deux étages (Haiku puis modèle du bot), relances dédupliquées, heures de silence, résumé quotidien, routines en langage naturel, Web Push, PWA | ✅ |
| 5 | Sous-agents léger (Haiku 5.5) / expert (Opus 5.5) avec règles, raison obligatoire et traçage, limite quotidienne d'appels experts, tests, sauvegardes, revue de sécurité | ✅ |

## Vérifications effectuées

- **Tests automatisés**
  - `packages/shared` : décisions de source de calcul (tous les modes et seuils), alertes, règles de risque, anti-boucle, heures de silence, réglages.
  - `apps/server` : tests d'intégration sur un vrai PostgreSQL.
    - Authentification complète, CSRF, limitation des tentatives, codes de secours à usage unique.
    - File de tâches.
    - Exécution d'un bot avec un Agent SDK simulé : flux, reprise de session, **bascule abonnement → crédits API en cours d'exécution**, pause propre, hooks des sous-agents, transferts et blocage des boucles, validations.
    - Heartbeat, résumé, routines, compactage, alertes.
  - `apps/computer` : confinement des chemins, exécution, fichiers, WebSockets, Chromium réel.
  - `apps/ui` : logique du cache temps réel et rendu des composants.
- **Essais réels**
  - Services web et worker compilés puis démarrés pour de vrai.
  - Parcours complet par l'API : configuration, TOTP, refus du WebSocket sans session, création de bot, message, pause faute d'identifiants.
  - **Image Docker de production** (lecture seule, sans capacités Linux) : le binaire Claude Code de l'Agent SDK démarre, joint l'API d'Anthropic, et un identifiant refusé est détecté et géré.
  - **Image de l'ordinateur** avec le durcissement de docker-compose : Chromium sur écran virtuel, commandes en utilisateur non privilégié sans secret, VNC, terminal.

## Ce qui n'a pas pu être vérifié ici

- **Appels réels à Claude avec ton abonnement ou ta clé API** : aucun identifiant valide n'existe dans l'environnement de développement.
  L'intégration est vérifiée jusqu'à l'API d'Anthropic (refus d'une fausse clé), mais pas une vraie réponse de modèle.
  À tester en premier après déploiement : un message à un bot, puis l'écran Quota & budget.
- **Unités des événements de limite de l'abonnement** : `rate_limit_event.utilization` et `resetsAt` ne sont pas documentés
  précisément. Ant accepte une fraction ou un pourcentage, et des secondes ou des millisecondes. Les événements bruts sont
  conservés dans la table `subscription_events` pour calibrer si besoin.
- **Notifications push sur ton téléphone** : elles dépendent des clés VAPID et du navigateur. Utilise le bouton « Tester » des réglages.

## Limites connues (à connaître avant usage)

1. **Conformité de l'abonnement** : voir [ARCHITECTURE § 6.1](ARCHITECTURE.md#61-connexion-à-labonnement-sur-un-serveur-sans-écran).
   Le mode par défaut « Hybride prudent » limite l'abonnement à ce que tu déclenches.
2. **Navigateur libre** : la validation porte sur les clics et la touche Entrée **sur les sites listés comme sensibles** (liste
   modifiable dans Réglages). Une action irréversible sur un site absent de la liste ne serait pas interceptée automatiquement.
   Les bots ont pour consigne d'appeler `request_approval` avant toute action irréversible. Les connecteurs structurés (v2)
   permettront une validation exhaustive.
3. **Injection de prompt** depuis une page web : l'ordinateur n'a aucun secret et ne peut pas joindre ton LAN. Les actions sensibles
   sont validées. En revanche, un bot trompé pourrait encore envoyer des informations vers un site public par une simple navigation.
4. **Commandes longues** : 280 s maximum par appel `computer_exec`. Au-delà, l'agent lance la commande en arrière-plan et suit son journal.
5. **Coûts** : ce sont des estimations de l'Agent SDK. La limite de dépense dans la Claude Console reste le garde-fou ultime.
6. **Pas de recherche sémantique** dans la mémoire (Claude uniquement, pas d'embeddings) : la recherche est en plein texte.
7. **Hors périmètre v1**, comme prévu : la voix et les connecteurs Gmail, Calendar, X, GitHub et Discord. L'architecture les
   prévoit (outils MCP supplémentaires + table de connecteurs).
