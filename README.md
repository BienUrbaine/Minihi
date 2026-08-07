# Kokolanek

Carte web de consultation des périmètres d’aide au logement.

## Fonctionnalités

- recherche d’adresse via le service public IGN / Géoplateforme ;
- affichage des 14 périmètres issus de `DB_PAL` ;
- test spatial dans le navigateur ;
- affichage du dispositif et de la commune ;
- placement manuel d’un point sur la carte.

## Données

Le référentiel publié est généré à partir de `DB_PAL_Urbanis.gpkg`. Treize des quatorze zones disposent actuellement d’un libellé de dispositif ; la zone `fid 14` reste signalée comme non renseignée.

## Publication

Le site est statique et conçu pour GitHub Pages. Ouvrir `index.html` via un serveur HTTP local pour le tester.
