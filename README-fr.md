# Restauration au Niveau Base de Données PostgreSQL Multi-Tenant sur AWS

[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](https://github.com/aws/mit-0)
[![CDK Version](https://img.shields.io/badge/CDK-v2.181.1-blue.svg)](https://docs.aws.amazon.com/cdk/v2/)

⚠️ **Utilisation en Développement/Test Uniquement** : Ce projet open source est conçu pour les environnements de développement et de test. Les déploiements en production peuvent nécessiter une revue de sécurité supplémentaire, des optimisations de performance et des considérations opérationnelles.

## Vue d'ensemble

De nombreuses applications adoptent des architectures qui isolent les données de chaque client (appelé aussi tenant) pour des raisons de sécurité, de performance et de conformité. Deux approches courantes sont largement utilisées : l'isolation par instance dédiée où chaque tenant dispose de sa propre instance Amazon Relational Database Service (Amazon RDS) ou cluster Amazon Aurora, et l'isolation par base de données ou schéma dédié où tous les tenants partagent la même instance Amazon RDS ou cluster Amazon Aurora mais disposent chacun de leur propre base de données ou schéma PostgreSQL.

Cette solution résout un défi critique des applications multi-tenant: comment restaurer les données d'un seul tenant sans impacter les autres ?
Les capacités natives d'Amazon RDS opèrent au niveau instance complète, pas au niveau granulaire des schémas individuels. Cette solution apporte une restauration automatisée au niveau schéma en utilisant uniquement les services managés AWS.

- Restaurer des schémas spécifiques sans affecter les autres tenants
- Maintenir les services en ligne pendant la restauration
- Comparer côte-à-côte les données historiques et actuelles
- Nettoyer automatiquement toutes les ressources temporaires

## Architecture

![Diagramme d'architecture](./architectures/architecture.png)

### Services AWS Principaux

La solution s'articule autour de quatre composants AWS principaux qui collaborent pour effectuer une restauration granulaire :

**AWS Step Functions** : agit comme l'orchestrateur central, coordonnant l'ensemble du processus de restauration à travers une machine d'état qui gère le cycle de vie complet : depuis la création d'une base de données restaurée temporaire jusqu'au nettoyage final des ressources, en passant par la validation des paramètres et la gestion des erreurs.

**Amazon Relational Database Service (Amazon RDS)** : il y a deux instances Amazon RDS ou deux clusters Amazon Aurora distincts dans ce processus :
- **Base de données de production** qui contient les données actuelles. C'est l'instance qui contient les schémas que l'on souhaite restaurer, et qui continue de servir les autres tenants en fonctionnement normal pendant toute la durée du processus de restauration.
- **Base de données temporaire** créée spécifiquement pendant et pour la restauration. Cette instance temporaire est générée soit par Point-in-Time Recovery (PITR) soit à partir d'un snapshot de l'instance de production, permettant de récupérer les données à l'état exact souhaité dans le passé. L'instance temporaire, isolée dans des sous-réseaux dédiés, sert uniquement de source d'extraction pour les données historiques, tandis que la base de production continue de fonctionner normalement sans interruption.

**AWS Database Migration Service (AWS DMS)** assure le transfert sélectif des données en copiant uniquement les schémas spécifiés depuis la base de données temporaire vers l'environnement de production. DMS applique des règles de transformation pour renommer les schémas de destination (ajout de suffixes), permettant ainsi une restauration côte-à-côte. Cette approche côte-à-côte est essentielle car la structure des schémas de production a pu évoluer depuis la sauvegarde (ajout de colonnes, modification de contraintes, nouvelles tables), rendant impossible un remplacement direct. La recréation avec un nouveau nom permet une comparaison sécurisée des données historiques sans risquer d'impacter la structure de production actuelle.

**Amazon Elastic Container Service (Amazon ECS)** : exécute des tâches spécialisées pour l'extraction (via pg_dump) et l'application des définitions DDL (Data Definition Language). Ces containers automatisés extraient la structure complète des schémas depuis la base temporaire (tables, contraintes, indexes, séquences, triggers) et recréent cette structure dans la base de production avec de nouveaux noms. Cette étape est essentielle car bien qu'AWS DMS prenne en charge la migration basique de schémas (création de tables et clés primaires), il ne recrée pas automatiquement les index secondaires, les clés étrangères, les contraintes complexes, ou d'autres éléments avancés de structure dans la base de données cible.

### Architecture Réseau

La solution déploie trois types de sous-réseaux pour l'isolation de sécurité :

- **Sous-réseaux base de données** : instances de base de données de production
- **Sous-réseaux de restauration** : infrastructure temporaire pour les opérations de récupération
- **VPC Endpoints** : connectivité privée vers les services AWS (AWS Secrets Manager, Amazon S3, Amazon Elastic Container Registry, ...)

## Workflow AWS Step Functions

<picture>
  <img alt="Step Functions Workflow" src="./architectures/stepfunctions.png" style="border: 1px solid #ddd; background-color: white; padding: 10px;" />
</picture>

La machine d'état AWS Step Functions orchestre un workflow qui coordonne Amazon RDS, AWS DMS, Amazon ECS et des fonctions Lambda pour effectuer l'opération de restauration au niveau base de données et/ou schéma.

La machine d'état gère le cycle de vie complet depuis le provisionnement de base de données temporaire jusqu'à la migration de données et le nettoyage des ressources, avec gestion d'erreurs et logique conditionnelle pour supporter différentes architectures de base de données (instances Amazon RDS ou clusters Amazon Aurora) et méthodes de restauration (Point-in-Time-Recovery vs snapshots). Le processus entier opère via les APIs AWS tout en maintenant le suivi des opérations et les logs.

### Workflow de Restauration (7 Phases)

#### Phase 1 : Initialisation & Préparation
La machine d'état commence par valider les paramètres d'entrée et établir des variables globales incluant des identifiants de ressources uniques. Ensuite, elle enregistre la demande de restauration dans une table Amazon DynamoDB pour un suivi d'audit complet, puis détermine l'architecture de base de données en interrogeant RDS pour détecter si la base de production est une instance RDS standard ou un cluster Aurora, les APIs de restaurations étant différentes selon si l'on utilise une base de données Amazon RDS pour PostgreSQL ou un cluster Amazon Aurora PostgreSQL.

Le provisionnement de l'instance de réplication AWS DMS étant une opération longue, la solution l'initie immédiatement pour réduire le temps d'attente global de la restauration.

#### Phase 2 : Création d'une Instance Temporaire

Cette phase crée une instance ou un cluster de base de données temporaire dans des sous-réseaux isolés en utilisant soit le Point-in-Time Recovery ou la restauration depuis un snapshot (un paramètre d'entrée de la machine d'état permet de déterminer quelle option utiliser). La base de données temporaire est provisionnée avec les groupes de sécurité appropriés car elle n'est nécessaire que pour l'extraction de données par AWS DMS et l'extraction du DDL par Amazon ECS. Le workflow surveille le processus de provisionnement via des boucles de polling, attendant que la base de données temporaire atteigne le statut "available" avant de procéder à la phase suivante.

#### Phase 3 : Extraction et Préparation de Schéma
Une fois la base de données temporaire prête, la step function :
- **Crée un secret temporaire** depuis une AWS Lambda pour la connectivité DMS à la base de données restaurée. AWS DMS utilise AWS Secrets Manager pour l'authentification de base de données Amazon RDS et Amazon Aurora. La lambda détermine d'abord le timestamp cible de la restauration (soit la date de création du snapshot, soit le timestamp PITR spécifié), puis analyse l'historique des versions du secret original pour identifier quelle version était active à ce moment précis. Cette approche garantit que les credentials utilisés correspondent exactement à ceux qui étaient valides au moment des données restaurées, gérant ainsi automatiquement les rotations de mots de passe qui auraient pu avoir lieu entre la sauvegarde et la restauration. Un nouveau secret temporaire est ensuite créé avec ces credentials historiques et en mettant à jour le paramètre host pour pointer vers l'instance de base de données temporaire.
- **Extrait les définitions DDL complètes** incluant tables, contraintes, indexes, séquences, vues, procédures stockées, triggers etc... en utilisant une tâche Amazon ECS spécialisée qui utilise pg_dump. Le DDL extrait est ensuite divisé en deux parties et stocké sur Amazon S3 sous trois formats :
  - **DDL pré-DMS** (tables, clés primaires, séquences) qui est appliqué immédiatement à la base de données de production pour créer les structures essentielles avec des noms de schémas transformés incluant un suffixe temporel (par exemple, le schéma customer_a1 devient customer_a1_20240128143000)
  - **DDL post-DMS** (contraintes, index secondaires, clés étrangères, triggers et tout le reste) qui sera appliqué après la migration des données
  - **DDL complet** conservé comme référence pour audit et troubleshooting

Cette séparation est nécessaire car les contraintes d'intégrité référentielle (comme les clés étrangères) peuvent faire échouer la migration DMS, celui-ci copiant les tables dans un ordre qui ne respecte pas forcément les dépendances entre elles. Bien qu'il soit techniquement possible de déterminer et d'imposer un ordre de migration respectant ces dépendances, cette solution a délibérément choisi de laisser DMS gérer l'ordre des tables afin de simplifier l'implémentation et de maintenir la facilité de maintenance. La migration des données s'effectue donc d'abord sans contraintes, puis toutes les règles d'intégrité sont appliquées une fois le transfert de données terminé.

#### Phase 4 : Orchestration de Migration
- Vérifie que l’instance de réplication créée dans la phase 1 est prête
- Crée des endpoints DMS séparés pour les connexions source (base de données temporaire) et cible (base de données de production)
- Le workflow effectue des tests de connexion obligatoires pour valider que les deux endpoints peuvent communiquer avec succès avec leurs bases de données respectives via les secrets AWS Secrets Manager propres à chaque instance avant de procéder à la migration de données
- Traite chaque schéma dans la liste de schémas fournis en entrée de manière concurrente, créant des tâches de réplication DMS individuelles avec des règles de mapping de tables qui sélectionnent seulement les données du schéma spécifié
- Surveille chaque tâche de réplication à travers son cycle de vie complet depuis la création jusqu'à l'exécution et la completion.

#### Phase 5 : Application du DDL Post-DMS
- Une fois la migration des données terminée, une tâche Amazon ECS applique le DDL post-DMS pour ajouter tous les éléments structurels omis durant la migration (index secondaires, clés étrangères, contraintes, triggers, vues, procédures stockées), finalisant ainsi l'intégrité et les performances des schémas restaurés.

#### Phase 6 : Nettoyage
- Supprime toutes les ressources temporaires en parallèle incluant :
  - Instance ou cluster de base de données temporaire
  - Infrastructure AWS DMS : Tâches, endpoints et instance
  - Secret temporaire dans Amazon Secrets Manager
  - Fichiers DDL stockés dans le bucket S3
- Le processus de nettoyage s'exécute aussi en cas d'échec, prévenant les coûts inutiles
- Le processus de nettoyage s'exécute également en cas d'échec à n'importe quelle étape, prévenant l'accumulation de ressources temporaires et les coûts inutiles.

#### Phase 7 : Validation et Journalisation
- La Step Function sauvegarde le statut final de l'opération dans DynamoDB (succès ou échec) avec les détails de l'exécution, puis retourne un statut de completion indiquant le résultat de la restauration. Cette traçabilité permet un audit complet des opérations de restauration et facilite le troubleshooting en cas de problème.

## Paramètres d'Entrée Step Functions

La Step Functions prend en entrée un payload JSON qui définit précisément le périmètre et la source de la restauration. Le format varie selon la méthode de récupération choisie :

### Restauration Point-in-Time Recovery (PITR)
```json
{
  "database": "<databaseName>",
  "schemas": ["<schema1>", "<schema2>", "..."],
  "restoreTime": "2024-01-28T14:30:00Z"
}
```

### Restauration depuis un Snapshot
```json
{
  "database": "<databaseName>",
  "schemas": ["<schema1>", "<schema2>", "..."],
  "snapshotId": "<snapshotId>"
}
```

### Paramètres Obligatoires

| Paramètre | Description | Options |
|-----------|-------------|---------|
| `database` | Nom de la base de données PostgreSQL dans l'instance Amazon RDS ou le cluster Amazon Aurora contenant les données à restaurer | Nom de base de données existante |
| `schemas` | Tableau des noms de schémas à inclure dans la restauration | |
| `restoreTime` OU `snapshotId` | **Soit** timestamp ISO pour PITR **soit** identifiant de snapshot | Doit être dans la fenêtre de rétention des sauvegardes |

## Ce que la Solution Déploie

La solution crée un environnement PostgreSQL multi-tenant complet pour tester et démontrer les capacités de restauration au niveau schéma. Cela inclut à la fois l'infrastructure AWS et une structure de base de données réaliste qui simule une application SaaS de production.

### Infrastructure AWS

**Infrastructure Réseau :**
- **Amazon VPC** avec des sous-réseaux publics et privés dédiés (2 publics, 2 privés pour la base de données de production, 2 privés pour le processus de restauration)
- **VPC Endpoints** pour l'accès privé aux services AWS (Secrets Manager, S3, CloudWatch, Step Functions, etc.)
- **Groupes de Sécurité** avec des règles d'accès à privilèges minimaux pour la base de données,les tâches ECS, et les lambdas

**Ressources de Base de Données :**
- **Amazon RDS PostgreSQL ou Amazon Aurora** instance avec la configuration sélectionnée
- **AWS Secrets Manager** avec des credentials de base de données chiffrés et support de rotation automatique
- **Génération continue de données** via AWS Lambda créant de nouveaux enregistrements chaque minute pour simuler une activité d'application réelle

**Services d'Orchestration Principaux :**
- **AWS Step Functions** avec une machine d'état de restauration pré-configurée
- **Cluster Amazon ECS** et définitions de tâches Fargate pour l'extraction et l'application DDL
- **Infrastructure AWS DMS** incluant groupes de sécurité, groupes de sous-réseaux, et rôles IAM de service
- **Bucket Amazon S3** pour le stockage temporaire des scripts DDL pendant les restaurations avec politiques de cycle de vie

**Gestion et Surveillance :**
- **Table DynamoDB** pour l'historique des opérations de restauration et le suivi d'audit
- **Logs CloudWatch** pour tous les composants de service avec politiques de rétention appropriées

**Fonctions Lambda :**
- **Create Secret Lambda** : crée des secrets temporaires avec les credentials historiques appropriés pour la connectivité DMS
- **Init Database Lambda** : initialise la structure de la base de données lors du déploiement (schémas, tables, données d'exemple)
- **Simulate Activity Lambda** : génère en continu de nouvelles données pour simuler l'activité d'une application réelle

### Types de Base de Données Supportés

La solution supporte plusieurs options de déploiement PostgreSQL :

| Valeur de Contexte | Type de Base de Données | Configuration | Cas d'Usage |
|-------------------|------------------------|---------------|-------------|
| `SingleAz` | RDS PostgreSQL Single-AZ | db.t4g.micro, stockage 20GB | Environnements de développement, test |
| `MultiAz` | RDS PostgreSQL Multi-AZ | db.t4g.micro, stockage 20GB | Charges de travail de production nécessitant HA |
| `AuroraProvisioned` | Aurora PostgreSQL | instance writer db.t4g.medium | Charges de travail de production haute performance |
| `AuroraServerless` | Aurora Serverless v2 | auto-scaling 0.5-1 ACU | Charges de travail variables ou imprévisibles |

### Structure de Base de Données Multi-Tenant

La solution déployée implémente un pattern d'**isolation schéma-par-tenant** avec deux niveaux d'organisation :

#### Organisation des Bases de Données et Schémas

| Base de Données | Schémas | Objectif |
|-----------------|---------|----------|
| `tenant_a` | `customer_a1`, `customer_a2` | Environnements clients du Tenant A |
| `tenant_b` | `customer_b1`, `customer_b2` | Environnements clients du Tenant B |
| `postgres` | `public` | Base de données système (PostgreSQL par défaut) |

#### Structure de Tables par Schéma

Chaque schéma client contient des structures de tables identiques avec des données d'exemple pour tester les capacités de restauration :

| Table | Description |
|-------|-------------|
| **users** | Comptes utilisateurs d'exemple avec divers types de données (JSONB, enums, timestamps) |
| **products** | Enregistrements de produits avec arrays, attributs JSONB, et données d'inventaire |
| **orders** | Enregistrements de commandes démontrant les relations de clés étrangères |
| **order_items** | Articles de ligne de commande montrant des relations de tables complexes |

#### Fonctionnalités PostgreSQL Avancées

- **Séquences** : séquences personnalisées pour les IDs utilisateur et numéros de commande
- **Fonctions** : génération de codes utilisateur et triggers de mise à jour de timestamp
- **Index** : optimisation de performance sur les colonnes fréquemment interrogées
- **Contraintes** : clés étrangères, contraintes uniques, et contraintes de vérification
- **Row Level Security** : politiques d'isolation des données tenant
- **Vues** : vues de reporting agrégées pour l'analyse utilisateur et produit

## Déployer la Solution

### Prérequis

Avant de déployer la solution de restauration au niveau base de données, assurez-vous d'avoir :

- **Compte AWS** avec des permissions administratives
- **AWS CLI** v2.0+ configuré
- **Node.js** (version 18 ou ultérieure) et npm
- **AWS CDK** CLI (version 2 ou supérieure)
- **Docker** fonctionnant localement pour le packaging des tâches Amazon ECS

### Étapes de Déploiement

**Clonez le repository :**
```bash
git clone https://github.com/aws-samples/database-level-restore
cd database-level-restore
```

**Buildez le projet :**
```bash
npm install
npm run build
```

**Déployez le projet :**

Si vous n'avez pas déjà lancé le bootstrap de l'environnement AWS:

```bash
cdk bootstrap
```

ensuite:

```bash
cdk deploy DatabaseLevelRestoreStack --context selectedDatabase=AuroraServerless
```

Avec Aurora Serverless, vous pouvez utiliser [Aurora query editor](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/query-editor.html) pour éxécuter des requêtes SQL depuis la console AWS et vérifier le bon déroulement de la migration.


### Pour Lancer une Restauration

**1. Accédez à la Console AWS :**
Naviguez vers "Step Functions" dans la Console AWS où la solution est déployée.

**2. Démarrez l'Exécution :**
Trouvez et cliquez sur la machine d'état déployée, puis cliquez sur "Start execution".

**3. Fournissez l'Entrée :**
Fournissez une entrée basée sur votre stratégie désirée. Par exemple, pour la solution déployée :

Pour Point-in-Time Recovery :
```json
{
  "database": "tenant_a",
  "schemas": ["customer_a1", "customer_a2"],
  "restoreTime": "2024-01-28T14:30:00Z"
}
```

Remplacez "2024-01-28T14:30:00Z" par une date de restauration PITR valide.

Pour une récupération basée sur un snapshot :
```json
{
  "database": "tenant_a",
  "schemas": ["customer_a1", "customer_a2"],
  "snapshotId": "rds:databaselevelrestorestack-database-xxxxx-2024-01-28-11-38"
}
```

**4. Surveillez l'Exécution :**
Attendez la complétion de la State Machine.

**5. Visualisez les Résultats :**
Une fois terminée, la solution crée un nouveau schéma de récupération nommé par exemple `customer_a1_1706443800000` (le suffixe est un timestamp) dans la base de données de production, contenant les données migrées depuis l'instance de base de données temporaire restaurée. AWS DMS copie toutes les données des tables des schémas sélectionnés dans la base de données temporaire vers de nouveaux schémas de récupération dans l'environnement de production, permettant une comparaison côte à côte avec les schémas originaux sans écraser ou affecter les données de production existantes.

## Coût de la Solution

Ce coût est estimé pour la région de Paris (eu-west-3).

### Coût de l'Infrastructure Déployée

**Amazon RDS ou Amazon Aurora :** selon le type de base de données sélectionné lors du déploiement

| Type de Base de Données | Configuration | Coût Mensuel | Coût Horaire |
|------------------------|---------------|--------------|--------------|
| **Amazon RDS PostgreSQL Single-AZ** | db.t4g.micro, stockage 20 GB | 15,80€ | ~0,022€ |
| **Amazon RDS PostgreSQL Multi-AZ** | db.t4g.micro, stockage 20 GB | 31,60€ | ~0,043€ |
| **Amazon Aurora Provisioned** | 1 instance writer : db.t4g.medium | 59,97€ | ~0,082€ |
| **Amazon Aurora Serverless** | Min: 0,5 ACU, Max: 1 ACU | 51,10€ | ~0,070€ |

**Instance Amazon EC2 :** éligible au Free Tier

**Amazon VPC Endpoints :**
- 10 VPC endpoints × 2 ENIs par endpoint × 0,011€ = 0,22€ par heure

### Coût par Restauration

**AWS Step Functions :**
- AWS Step Functions workflow standard facture à la transition d'état. En moyenne, selon le temps d'attente dans les boucles polling pour que l'état des ressources passe à "available", on utilise 800 transitions d'état
- **Coût par exécution :** 0,025€

**AWS DMS :**
- AWS DMS est facturé uniquement durant le temps de restauration
- L'instance déployée dans la solution est une dms.t3.medium avec 20Gb de stockage
- Pour cette solution, un processus de restauration dure en moyenne 35min avec la phase de copie de données qui dure en moyenne 20min
- **Coût par exécution :** 0,028€
- *Formule de calcul : [(1 instance × 0,082€ horaire) + (20 GB × 0,12 mensuel) / 730 heures] / 60minutes) × 20minutes*

**Amazon S3 :** 0,00€ par exécution (couvert par le free tier)

**Amazon DynamoDB :** 0,00€ par exécution (couvert par le free tier)

**Coût par 1000 exécutions : ~55€**

## Nettoyage

Pour éviter d'encourir des charges, supprimez la solution en utilisant :

```bash
cdk destroy DatabaseLevelRestoreStack
```

## Améliorations Possibles

Bien que la solution actuelle fournisse des capacités complètes de restauration au niveau base de données et schéma pour PostgreSQL, plusieurs améliorations pourraient davantage améliorer sa fonctionnalité et sa valeur opérationnelle :

### Support Multi-Engine de Base de Données
L'architecture peut être étendue pour supporter des moteurs de base de données additionnels incluant MySQL, SQL Server, Oracle, et autres bases de données compatibles RDS. Cette expansion nécessiterait une logique d'extraction DDL spécifique au moteur et des templates de configuration DMS, mais les patterns d'orchestration de workflow et de gestion de ressources restent cohérents à travers les plateformes de base de données.

### Système de Notification Amélioré
Les notifications automatisées via une intégration avec Amazon Simple Notification Service (Amazon SNS) pourraient fournir des mises à jour en temps réel sur le progrès des opérations de restauration et le statut de completion.

### Granularité au Niveau Table
Étendre les capacités de restauration au niveau table fournirait un contrôle encore plus fin sur les opérations de récupération de données. Cette amélioration modifierait les règles de mapping de tables DMS pour cibler des tables spécifiques dans les schémas tout en maintenant l'intégrité référentielle via l'analyse de dépendances. Les administrateurs de base de données pourraient restaurer des tables corrompues sans affecter les données liées, réduisant le temps de restauration et minimisant la portée de validation de données requise post-restauration.

### Intégration DMS Serverless
Implémenter DMS Serverless éliminerait le besoin de planification de capacité. La solution pourrait provisionner dynamiquement la capacité DMS basée sur le volume de données actuel et la complexité de migration, fournissant un scaling automatique pour les grandes opérations de restauration tout en maintenant l'efficacité des coûts pour les tâches plus petites. Cette approche serait particulièrement bénéfique pour les organisations avec des patterns de restauration imprévisibles ou des tailles de base de données tenant variables.

### Validation de Données Automatisée
Les vérifications d'intégrité de données post-restauration pourraient automatiquement valider la précision de la restauration. Ces vérifications automatisées compareraient les données source et cible à la completion, générant des rapports de validation détaillés et signalant toute discordance pour révision. Des règles de validation personnalisées pourraient être configurées par tenant ou schéma pour vérifier des relations de données et contraintes spécifiques au business.

### Système de Rollback Intelligent
Les capacités de rollback automatique fourniraient des mécanismes de sécurité pour les opérations de restauration échouées ou corrompues. Si les vérifications de validation de données échouent ou des erreurs critiques surviennent pendant le processus de restauration, le système pourrait automatiquement supprimer les schémas de récupération et alerter les administrateurs sans intervention manuelle. Cette amélioration inclurait des triggers de rollback configurables, des procédures de nettoyage complètes, et un logging détaillé pour supporter le troubleshooting et les efforts d'amélioration de processus.

## Conclusion

Les capacités de restauration au niveau base de données adressent un gap critique dans les architectures d'applications multi-tenant. En combinant les services managés AWS dans un workflow orchestré, les organisations peuvent atteindre une récupération granulaire de données sans la complexité et l'overhead des solutions personnalisées.

Cette approche transforme la récupération de données d'un processus réactif et manuel en une capacité proactive et automatisée qui réduit la complexité opérationnelle. La solution tire parti de la fiabilité et de la scalabilité des services AWS tout en fournissant le contrôle granulaire nécessaire pour les applications multi-tenant modernes.

En implémentant cette solution, vous permettez une réponse rapide aux demandes de récupération de données client tout en maintenant les standards de sécurité, conformité, et excellence opérationnelle requis pour les environnements de production.

## Ressources de Documentation

- [Amazon Relational Database Service (Amazon RDS)](https://aws.amazon.com/fr/rds/features/?nc1=h_ls)
- [Amazon Aurora](https://docs.aws.amazon.com/fr_fr/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html)
- [AWS Database Migration Service (AWS DMS)](https://aws.amazon.com/fr/dms/features/)
- [Amazon Elastic Container Service (Amazon ECS)](https://aws.amazon.com/fr/ecs/features/)
- [AWS Step Functions](https://aws.amazon.com/fr/step-functions/features/)
- [AWS Secrets Manager](https://aws.amazon.com/fr/secrets-manager/features/)


## Signalement de Problèmes
Pour les rapports de bugs et demandes de fonctionnalités, veuillez créer des issues GitHub détaillées avec :
- Description claire du problème et comportement attendu
- Messages d'erreur complets et stack traces
- Logs CloudWatch pertinents et détails d'exécution
- Informations de région AWS et compte (anonymisées)
- Étapes pour reproduire le problème

## Licence

Ce projet est sous licence MIT-0. Voir le fichier [LICENSE](LICENSE) pour les détails.

---

**Construit par l'Équipe Architecture de Solutions AWS**