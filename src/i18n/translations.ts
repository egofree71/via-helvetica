/**
 * Business context: centralizes every user-facing label so the interface can
 * switch languages without scattering translation logic across map modules.
 */

/** Languages supported by the application interface and GeoAdmin search. */
export const SUPPORTED_LANGUAGES = ['fr', 'de', 'it', 'en'] as const;

/** One supported interface language. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Metadata used by number formatting and the compact language selector. */
export const LANGUAGE_METADATA: Record<
  Language,
  { locale: string; shortLabel: string }
> = {
  fr: { locale: 'fr-CH', shortLabel: 'FR' },
  de: { locale: 'de-CH', shortLabel: 'DE' },
  it: { locale: 'it-CH', shortLabel: 'IT' },
  en: { locale: 'en-CH', shortLabel: 'EN' },
};

const frenchTranslations = {
  'app.title':
    'Via Helvetica – Planificateur d’itinéraires de randonnée en Suisse',
  'app.description':
    'Planifiez des itinéraires de randonnée en Suisse sur les cartes officielles, consultez le dénivelé et les informations sur les sentiers, puis importez ou exportez des fichiers GPX.',
  'about.open': 'À propos de Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Planifiez vos itinéraires de randonnée en Suisse sur les cartes officielles.',
  'about.description':
    'Via Helvetica est une application web gratuite et open source. Elle permet de créer ou d’importer un itinéraire, d’en consulter la distance, le dénivelé et le profil d’altitude, puis de l’exporter au format GPX.',
  'about.privacy':
    'Aucun compte n’est nécessaire. Les itinéraires ne sont pas enregistrés sur un serveur appartenant à Via Helvetica.',
  'about.safetyTitle': 'À savoir',
  'about.safety':
    'Le calcul d’itinéraire est une aide expérimentale à la planification. Via Helvetica ne fournit pas de guidage en direct. Vérifiez les conditions, fermetures et avis officiels avant votre départ.',
  'about.projectTitle': 'Projet',
  'about.createdBy': 'Créé par',
  'about.support': 'Support',
  'about.sourceCode': 'Code source',
  'about.license': 'Licence',
  'about.linkedin': 'Profil professionnel',
  'about.creditsTitle': 'Cartes et données',
  'about.maps': 'Cartes et géodonnées',
  'about.switzerlandMobilityHiking': 'À pied SuisseMobile',
  'about.closures': 'Fermetures et déviations',
  'about.dangerZones': 'Avis de tir et zones de danger',
  'about.transportStops': 'Arrêts de transports publics',
  'about.departures': 'Horaires des transports publics',
  'about.close': 'Fermer',
  'language.select': 'Choisir la langue',
  'language.fr': 'Français',
  'language.de': 'Allemand',
  'language.it': 'Italien',
  'language.en': 'Anglais',

  'search.placeholder': 'Rechercher une localité…',
  'search.label': 'Rechercher une localité',
  'search.clearLabel': 'Effacer la recherche',
  'search.clearTitle': 'Effacer',
  'search.loading': 'Recherche…',
  'search.unavailable': 'La recherche est momentanément indisponible.',
  'search.noResults': 'Aucun lieu trouvé.',
  'search.results': 'Résultats de recherche',
  'search.category.zipcode': 'Localité ou code postal',
  'search.category.gg25': 'Commune',
  'search.category.gazetteer': 'Nom géographique',

  'route.toolbar': 'Itinéraire',
  'route.create': 'Créer un itinéraire',
  'route.exitCreation': 'Quitter le mode création d’itinéraire',
  'route.addFirstPoint':
    'Ajoutez un premier point pour choisir le type de tracé',
  'route.followPaths': 'Suivre les chemins de randonnée',
  'route.straightSegments': 'Ajouter des segments linéaires',
  'route.undoChange': 'Annuler la dernière modification',
  'route.undo': 'Annuler',
  'route.redoChange': 'Refaire la dernière modification',
  'route.redo': 'Refaire',
  'route.reverse': 'Inverser l’itinéraire',
  'route.closeLoop': 'Boucler l’itinéraire',
  'route.openLoop': 'Ouvrir l’itinéraire',
  'route.delete': 'Supprimer l’itinéraire',
  'route.waypointHint': 'Glisser pour déplacer ; cliquer pour supprimer.',
  'route.segmentHint': 'Cliquer pour prolonger, glisser pour ajouter un point de passage.',
  'route.export': 'Exporter l’itinéraire',
  'route.import': 'Charger un itinéraire GPX',
  'route.importError':
    'Ce fichier GPX ne contient pas d’itinéraire valide.',
  'route.importTooLarge': 'Ce fichier GPX est trop volumineux.',
  'route.exportError':
    'L’itinéraire doit contenir au moins deux points pour être exporté.',
  'route.noNearbyPath':
    'Aucun chemin swissTLM3D n’a été trouvé à proximité de ce point.',
  'route.noConnectedPath':
    'Aucun chemin connecté n’a été trouvé entre ces deux points.',
  'route.areaTooLarge':
    'Ce segment est trop long pour le chargement dynamique actuel. Ajoutez un point intermédiaire.',
  'route.networkLoadError':
    'Le réseau swissTLM3D de cette zone n’a pas pu être chargé.',
  'route.hikingEnrichmentUnavailable':
    'Les informations sur les chemins de randonnée sont indisponibles. Pour cette session, le routage utilise uniquement le réseau de routes et de chemins swissTLM3D.',

  'geolocation.show': 'Afficher ma position',
  'geolocation.recenter': 'Recentrer sur ma position',
  'geolocation.unavailable':
    'La géolocalisation n’est pas disponible dans ce navigateur.',
  'geolocation.searching': 'Recherche de votre position…',
  'geolocation.outside': 'Votre position se trouve hors de la zone couverte.',
  'geolocation.permissionDenied': 'L’accès à votre position a été refusé.',
  'geolocation.positionUnavailable':
    'Votre position n’a pas pu être déterminée.',
  'geolocation.timeout':
    'La recherche de votre position a pris trop de temps.',
  'geolocation.error':
    'Une erreur est survenue pendant la géolocalisation.',

  'map.aria': 'Carte nationale suisse interactive',
  'map.controls': 'Contrôles de la carte',
  'map.layers.select': 'Choisir les couches de la carte',
  'map.layers.baseMaps': 'Fond de carte',
  'map.layers.information': 'Couches d’information',
  'map.baseMap.color': 'Carte couleur',
  'map.baseMap.gray': 'Carte grise',
  'map.baseMap.aerial': 'Photo aérienne',
  'hikingTrails.layer': 'Chemins de randonnée',
  'switzerlandMobilityHiking.layer': 'À pied SuisseMobile',
  'switzerlandMobilityHiking.panelAria':
    'Informations sur l’itinéraire SuisseMobile',
  'switzerlandMobilityHiking.close': 'Fermer',
  'switzerlandMobilityHiking.stage': 'Étape {number}',
  'switzerlandMobilityHiking.stageSection':
    'Étape {number} : {section}',
  'switzerlandMobilityHiking.routeNumber': 'Itinéraire {number}',
  'switzerlandMobilityHiking.unnamedRoute': 'Itinéraire SuisseMobile',
  'switzerlandMobilityHiking.multipleTitle':
    'Plusieurs itinéraires passent ici',
  'switzerlandMobilityHiking.multipleHint':
    'Choisissez l’itinéraire à afficher.',
  'switzerlandMobilityHiking.loading': 'Chargement de l’itinéraire…',
  'switzerlandMobilityHiking.loadError':
    'Les informations de cet itinéraire n’ont pas pu être chargées.',
  'switzerlandMobilityHiking.elevationUnavailable':
    'Profil d’altitude indisponible.',
  'closures.layer': 'Fermetures / déviations',
  'closures.title': 'Fermeture / déviation',
  'closures.close': 'Fermer',
  'closures.loading': 'Chargement des informations…',
  'closures.loadError':
    'Les informations de cette fermeture n’ont pas pu être chargées.',
  'shootingDangerZones.layer': 'Avis de tir / zones de danger',
  'shootingDangerZones.title': 'Avis de tir / zone de danger',
  'shootingDangerZones.close': 'Fermer',
  'shootingDangerZones.loading': 'Chargement des informations…',
  'shootingDangerZones.loadError':
    'Les informations de cette zone de danger n’ont pas pu être chargées.',
  'transportStops.layer': 'Arrêts de transports publics',
  'transportStops.title': 'Arrêt de transport public',
  'transportStops.close': 'Fermer',
  'transportStops.loading': 'Chargement des informations…',
  'transportStops.loadError':
    'Les informations de cet arrêt n’ont pas pu être chargées.',
  'transportStops.departures': 'Prochains départs',
  'transportStops.departuresLoading': 'Chargement des horaires…',
  'transportStops.departuresError':
    'Les prochains départs ne sont pas disponibles.',
  'transportStops.noDepartures': 'Aucun départ prochain trouvé.',
  'transportStops.delayTitle': 'Retard estimé en minutes',
  'transportStops.mode.train': 'Train',
  'transportStops.mode.metro': 'Métro',
  'transportStops.mode.tram': 'Tram',
  'transportStops.mode.bus': 'Bus',
  'transportStops.mode.boat': 'Bateau',
  'transportStops.mode.cableCar': 'Téléphérique',
  'transportStops.mode.chairlift': 'Télésiège',
  'transportStops.mode.funicular': 'Funiculaire',
  'transportStops.sbbDeparture': 'Utiliser comme départ sur CFF',
  'transportStops.sbbDestination': 'Utiliser comme destination sur CFF',
  'map.zoomIn': 'Zoomer',
  'map.zoomOut': 'Dézoomer',
  'map.fullscreenEnter': 'Afficher en plein écran',
  'map.fullscreenExit': 'Quitter le plein écran',
  'map.loading': 'Chargement de la carte swisstopo…',
  'map.loadFailed': 'Impossible de charger la carte.',
  'map.tileError':
    'Le navigateur n’a pas réussi à télécharger les tuiles swisstopo.',
  'map.retry': 'Vérifie la connexion Internet, puis recharge la page.',

  'statistics.aria': 'Statistiques de l’itinéraire',
  'statistics.distance': 'Distance',
  'statistics.ascent': 'Montée',
  'statistics.descent': 'Descente',
  'statistics.duration': 'Durée',
  'statistics.durationTitle':
    'Temps de marche estimé, pauses non comprises',
  'profile.show': 'Afficher le profil d’altitude',
  'profile.hide': 'Masquer le profil d’altitude',
  'profile.loading': 'Chargement du profil d’altitude',
  'profile.unavailable': 'Profil d’altitude indisponible',
  'profile.aria': 'Profil d’altitude de l’itinéraire',
  'profile.title': 'Profil d’altitude',
  'profile.rangeAria': 'Profil d’altitude de {minimum} à {maximum}',

  'units.hourShort': 'h',
  'units.minuteShort': 'min',
  'gpx.routeName': 'Itinéraire Via Helvetica',
  'gpx.nameLabel': 'Nom de l’itinéraire',
  'gpx.nameHint':
    'Ce nom sera utilisé dans le fichier GPX et dans les applications qui l’importent.',
  'gpx.cancel': 'Annuler',
} as const;

/** Translation keys accepted by the typed `t()` helper. */
export type TranslationKey = keyof typeof frenchTranslations;

const germanTranslations: Record<TranslationKey, string> = {
  'app.title':
    'Via Helvetica – Routenplaner für Wanderungen in der Schweiz',
  'app.description':
    'Planen Sie Wanderungen in der Schweiz auf offiziellen Karten, prüfen Sie Höhenprofil und Weginformationen und importieren oder exportieren Sie GPX-Dateien.',
  'about.open': 'Über Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Planen Sie Wanderungen in der Schweiz auf offiziellen Karten.',
  'about.description':
    'Via Helvetica ist eine kostenlose Open-Source-Webanwendung. Sie können eine Route erstellen oder importieren, Distanz, Höhenunterschiede und Höhenprofil prüfen und die Route als GPX exportieren.',
  'about.privacy':
    'Es ist kein Konto erforderlich. Routen werden nicht auf einem Server von Via Helvetica gespeichert.',
  'about.safetyTitle': 'Hinweis',
  'about.safety':
    'Die Routenberechnung ist eine experimentelle Planungshilfe. Via Helvetica bietet keine Live-Navigation. Prüfen Sie vor dem Aufbruch die Bedingungen, Sperrungen und offiziellen Hinweise.',
  'about.projectTitle': 'Projekt',
  'about.createdBy': 'Erstellt von',
  'about.support': 'Support',
  'about.sourceCode': 'Quellcode',
  'about.license': 'Lizenz',
  'about.linkedin': 'Berufsprofil',
  'about.creditsTitle': 'Karten und Daten',
  'about.maps': 'Karten und Geodaten',
  'about.switzerlandMobilityHiking': 'Wanderland SchweizMobil',
  'about.closures': 'Sperrungen und Umleitungen',
  'about.dangerZones': 'Schiessanzeigen und Gefahrenzonen',
  'about.transportStops': 'Haltestellen des öffentlichen Verkehrs',
  'about.departures': 'Fahrplandaten',
  'about.close': 'Schliessen',
  'language.select': 'Sprache wählen',
  'language.fr': 'Französisch',
  'language.de': 'Deutsch',
  'language.it': 'Italienisch',
  'language.en': 'Englisch',

  'search.placeholder': 'Ort suchen…',
  'search.label': 'Ort suchen',
  'search.clearLabel': 'Suche löschen',
  'search.clearTitle': 'Löschen',
  'search.loading': 'Suche…',
  'search.unavailable': 'Die Suche ist vorübergehend nicht verfügbar.',
  'search.noResults': 'Kein Ort gefunden.',
  'search.results': 'Suchergebnisse',
  'search.category.zipcode': 'Ort oder Postleitzahl',
  'search.category.gg25': 'Gemeinde',
  'search.category.gazetteer': 'Geografischer Name',

  'route.toolbar': 'Route',
  'route.create': 'Route erstellen',
  'route.exitCreation': 'Routenerstellung beenden',
  'route.addFirstPoint':
    'Fügen Sie zuerst einen Punkt hinzu, um die Linienart zu wählen',
  'route.followPaths': 'Wanderwegen folgen',
  'route.straightSegments': 'Gerade Segmente hinzufügen',
  'route.undoChange': 'Letzte Änderung rückgängig machen',
  'route.undo': 'Rückgängig',
  'route.redoChange': 'Letzte Änderung wiederherstellen',
  'route.redo': 'Wiederholen',
  'route.reverse': 'Route umkehren',
  'route.closeLoop': 'Route als Rundweg schliessen',
  'route.openLoop': 'Rundweg öffnen',
  'route.delete': 'Route löschen',
  'route.waypointHint': 'Zum Verschieben ziehen; zum Löschen klicken.',
  'route.segmentHint': 'Klicken zum Fortsetzen, ziehen zum Einfügen eines Wegpunkts.',
  'route.export': 'Route exportieren',
  'route.import': 'GPX-Route laden',
  'route.importError':
    'Diese GPX-Datei enthält keine gültige Route.',
  'route.importTooLarge': 'Diese GPX-Datei ist zu gross.',
  'route.exportError':
    'Die Route muss mindestens zwei Punkte enthalten, damit sie exportiert werden kann.',
  'route.noNearbyPath':
    'In der Nähe dieses Punkts wurde kein swissTLM3D-Weg gefunden.',
  'route.noConnectedPath':
    'Zwischen diesen beiden Punkten wurde kein verbundener Weg gefunden.',
  'route.areaTooLarge':
    'Dieses Segment ist für das aktuelle dynamische Laden zu lang. Fügen Sie einen Zwischenpunkt hinzu.',
  'route.networkLoadError':
    'Das swissTLM3D-Netz in diesem Gebiet konnte nicht geladen werden.',
  'route.hikingEnrichmentUnavailable':
    'Die Wanderweg-Informationen sind nicht verfügbar. Für diese Sitzung verwendet die Routenberechnung nur das swissTLM3D-Strassen- und Wegenetz.',

  'geolocation.show': 'Meinen Standort anzeigen',
  'geolocation.recenter': 'Auf meinen Standort zentrieren',
  'geolocation.unavailable':
    'Die Standortbestimmung ist in diesem Browser nicht verfügbar.',
  'geolocation.searching': 'Standort wird gesucht…',
  'geolocation.outside':
    'Ihr Standort liegt ausserhalb des abgedeckten Gebiets.',
  'geolocation.permissionDenied':
    'Der Zugriff auf Ihren Standort wurde verweigert.',
  'geolocation.positionUnavailable':
    'Ihr Standort konnte nicht bestimmt werden.',
  'geolocation.timeout': 'Die Standortsuche hat zu lange gedauert.',
  'geolocation.error':
    'Bei der Standortbestimmung ist ein Fehler aufgetreten.',

  'map.aria': 'Interaktive Schweizer Landeskarte',
  'map.controls': 'Kartensteuerung',
  'map.layers.select': 'Kartenebenen auswählen',
  'map.layers.baseMaps': 'Kartenhintergrund',
  'map.layers.information': 'Informationsebenen',
  'map.baseMap.color': 'Farbkarte',
  'map.baseMap.gray': 'Graue Karte',
  'map.baseMap.aerial': 'Luftbild',
  'hikingTrails.layer': 'Wanderwege',
  'switzerlandMobilityHiking.layer': 'Wanderland SchweizMobil',
  'switzerlandMobilityHiking.panelAria':
    'Informationen zur SchweizMobil-Wanderroute',
  'switzerlandMobilityHiking.close': 'Schliessen',
  'switzerlandMobilityHiking.stage': 'Etappe {number}',
  'switzerlandMobilityHiking.stageSection':
    'Etappe {number}: {section}',
  'switzerlandMobilityHiking.routeNumber': 'Route {number}',
  'switzerlandMobilityHiking.unnamedRoute': 'SchweizMobil-Wanderroute',
  'switzerlandMobilityHiking.multipleTitle':
    'Hier verlaufen mehrere Routen',
  'switzerlandMobilityHiking.multipleHint':
    'Wählen Sie die Route aus, die angezeigt werden soll.',
  'switzerlandMobilityHiking.loading': 'Route wird geladen…',
  'switzerlandMobilityHiking.loadError':
    'Die Informationen zu dieser Route konnten nicht geladen werden.',
  'switzerlandMobilityHiking.elevationUnavailable':
    'Höhenprofil nicht verfügbar.',
  'closures.layer': 'Sperrungen / Umleitungen',
  'closures.title': 'Sperrung / Umleitung',
  'closures.close': 'Schliessen',
  'closures.loading': 'Informationen werden geladen…',
  'closures.loadError':
    'Die Informationen zu dieser Sperrung konnten nicht geladen werden.',
  'shootingDangerZones.layer': 'Schiessanzeigen / Gefahrenzonen',
  'shootingDangerZones.title': 'Schiessanzeige / Gefahrenzone',
  'shootingDangerZones.close': 'Schliessen',
  'shootingDangerZones.loading': 'Informationen werden geladen…',
  'shootingDangerZones.loadError':
    'Die Informationen zu dieser Gefahrenzone konnten nicht geladen werden.',
  'transportStops.layer': 'Haltestellen des öffentlichen Verkehrs',
  'transportStops.title': 'Haltestelle des öffentlichen Verkehrs',
  'transportStops.close': 'Schliessen',
  'transportStops.loading': 'Informationen werden geladen…',
  'transportStops.loadError':
    'Die Informationen zu dieser Haltestelle konnten nicht geladen werden.',
  'transportStops.departures': 'Nächste Abfahrten',
  'transportStops.departuresLoading': 'Abfahrten werden geladen…',
  'transportStops.departuresError':
    'Die nächsten Abfahrten sind nicht verfügbar.',
  'transportStops.noDepartures': 'Keine nächsten Abfahrten gefunden.',
  'transportStops.delayTitle': 'Geschätzte Verspätung in Minuten',
  'transportStops.mode.train': 'Zug',
  'transportStops.mode.metro': 'Metro',
  'transportStops.mode.tram': 'Tram',
  'transportStops.mode.bus': 'Bus',
  'transportStops.mode.boat': 'Schiff',
  'transportStops.mode.cableCar': 'Seilbahn',
  'transportStops.mode.chairlift': 'Sesselbahn',
  'transportStops.mode.funicular': 'Standseilbahn',
  'transportStops.sbbDeparture': 'Als Abfahrtsort bei SBB verwenden',
  'transportStops.sbbDestination': 'Als Ziel bei SBB verwenden',
  'map.zoomIn': 'Vergrössern',
  'map.zoomOut': 'Verkleinern',
  'map.fullscreenEnter': 'Im Vollbild anzeigen',
  'map.fullscreenExit': 'Vollbild verlassen',
  'map.loading': 'swisstopo-Karte wird geladen…',
  'map.loadFailed': 'Die Karte konnte nicht geladen werden.',
  'map.tileError':
    'Der Browser konnte die swisstopo-Kacheln nicht herunterladen.',
  'map.retry':
    'Prüfen Sie die Internetverbindung und laden Sie die Seite neu.',

  'statistics.aria': 'Routenstatistik',
  'statistics.distance': 'Distanz',
  'statistics.ascent': 'Aufstieg',
  'statistics.descent': 'Abstieg',
  'statistics.duration': 'Dauer',
  'statistics.durationTitle':
    'Geschätzte Gehzeit ohne Pausen',
  'profile.show': 'Höhenprofil anzeigen',
  'profile.hide': 'Höhenprofil ausblenden',
  'profile.loading': 'Höhenprofil wird geladen',
  'profile.unavailable': 'Höhenprofil nicht verfügbar',
  'profile.aria': 'Höhenprofil der Route',
  'profile.title': 'Höhenprofil',
  'profile.rangeAria': 'Höhenprofil von {minimum} bis {maximum}',

  'units.hourShort': 'Std.',
  'units.minuteShort': 'Min.',
  'gpx.routeName': 'Via-Helvetica-Route',
  'gpx.nameLabel': 'Name der Route',
  'gpx.nameHint':
    'Dieser Name wird in der GPX-Datei und in Anwendungen verwendet, die sie importieren.',
  'gpx.cancel': 'Abbrechen',
};

const italianTranslations: Record<TranslationKey, string> = {
  'app.title':
    'Via Helvetica – Pianificatore di itinerari escursionistici in Svizzera',
  'app.description':
    'Pianifica itinerari escursionistici in Svizzera sulle carte ufficiali, consulta dislivello e informazioni sui sentieri e importa o esporta file GPX.',
  'about.open': 'Informazioni su Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Pianifica itinerari escursionistici in Svizzera sulle carte ufficiali.',
  'about.description':
    'Via Helvetica è un’applicazione web gratuita e open source. Permette di creare o importare un itinerario, consultarne distanza, dislivello e profilo altimetrico, quindi esportarlo in formato GPX.',
  'about.privacy':
    'Non è necessario alcun account. Gli itinerari non vengono salvati su un server di Via Helvetica.',
  'about.safetyTitle': 'Da sapere',
  'about.safety':
    'Il calcolo dell’itinerario è un aiuto sperimentale alla pianificazione. Via Helvetica non offre navigazione in tempo reale. Prima di partire, verifica condizioni, chiusure e avvisi ufficiali.',
  'about.projectTitle': 'Progetto',
  'about.createdBy': 'Creato da',
  'about.support': 'Supporto',
  'about.sourceCode': 'Codice sorgente',
  'about.license': 'Licenza',
  'about.linkedin': 'Profilo professionale',
  'about.creditsTitle': 'Carte e dati',
  'about.maps': 'Carte e geodati',
  'about.switzerlandMobilityHiking': 'A piedi SvizzeraMobile',
  'about.closures': 'Chiusure e deviazioni',
  'about.dangerZones': 'Avvisi di tiro e zone di pericolo',
  'about.transportStops': 'Fermate dei trasporti pubblici',
  'about.departures': 'Orari dei trasporti pubblici',
  'about.close': 'Chiudi',
  'language.select': 'Scegli la lingua',
  'language.fr': 'Francese',
  'language.de': 'Tedesco',
  'language.it': 'Italiano',
  'language.en': 'Inglese',

  'search.placeholder': 'Cerca una località…',
  'search.label': 'Cerca una località',
  'search.clearLabel': 'Cancella la ricerca',
  'search.clearTitle': 'Cancella',
  'search.loading': 'Ricerca…',
  'search.unavailable': 'La ricerca non è momentaneamente disponibile.',
  'search.noResults': 'Nessuna località trovata.',
  'search.results': 'Risultati della ricerca',
  'search.category.zipcode': 'Località o codice postale',
  'search.category.gg25': 'Comune',
  'search.category.gazetteer': 'Nome geografico',

  'route.toolbar': 'Itinerario',
  'route.create': 'Crea un itinerario',
  'route.exitCreation': 'Esci dalla modalità di creazione',
  'route.addFirstPoint':
    'Aggiungi un primo punto per scegliere il tipo di tracciato',
  'route.followPaths': 'Segui i sentieri escursionistici',
  'route.straightSegments': 'Aggiungi segmenti rettilinei',
  'route.undoChange': 'Annulla l’ultima modifica',
  'route.undo': 'Annulla',
  'route.redoChange': 'Ripristina l’ultima modifica',
  'route.redo': 'Ripristina',
  'route.reverse': 'Inverti l’itinerario',
  'route.closeLoop': 'Chiudi l’anello',
  'route.openLoop': 'Apri l’anello',
  'route.delete': 'Elimina l’itinerario',
  'route.waypointHint': 'Trascina per spostare; fai clic per eliminare.',
  'route.segmentHint': 'Fai clic per continuare, trascina per inserire un punto di passaggio.',
  'route.export': 'Esporta l’itinerario',
  'route.import': 'Carica un itinerario GPX',
  'route.importError':
    'Questo file GPX non contiene un itinerario valido.',
  'route.importTooLarge': 'Questo file GPX è troppo grande.',
  'route.exportError':
    'L’itinerario deve contenere almeno due punti per poter essere esportato.',
  'route.noNearbyPath':
    'Nessun percorso swissTLM3D è stato trovato vicino a questo punto.',
  'route.noConnectedPath':
    'Nessun percorso collegato è stato trovato tra questi due punti.',
  'route.areaTooLarge':
    'Questo segmento è troppo lungo per il caricamento dinamico attuale. Aggiungi un punto intermedio.',
  'route.networkLoadError':
    'Non è stato possibile caricare la rete swissTLM3D di questa zona.',
  'route.hikingEnrichmentUnavailable':
    'Le informazioni sui sentieri escursionistici non sono disponibili. Per questa sessione, il calcolo del percorso utilizza soltanto la rete di strade e sentieri swissTLM3D.',

  'geolocation.show': 'Mostra la mia posizione',
  'geolocation.recenter': 'Ricentra sulla mia posizione',
  'geolocation.unavailable':
    'La geolocalizzazione non è disponibile in questo browser.',
  'geolocation.searching': 'Ricerca della posizione…',
  'geolocation.outside':
    'La tua posizione si trova fuori dall’area coperta.',
  'geolocation.permissionDenied':
    'L’accesso alla tua posizione è stato negato.',
  'geolocation.positionUnavailable':
    'Non è stato possibile determinare la tua posizione.',
  'geolocation.timeout': 'La ricerca della posizione è durata troppo a lungo.',
  'geolocation.error':
    'Si è verificato un errore durante la geolocalizzazione.',

  'map.aria': 'Carta nazionale svizzera interattiva',
  'map.controls': 'Controlli della carta',
  'map.layers.select': 'Scegli i livelli della carta',
  'map.layers.baseMaps': 'Sfondo della carta',
  'map.layers.information': 'Livelli informativi',
  'map.baseMap.color': 'Carta a colori',
  'map.baseMap.gray': 'Carta grigia',
  'map.baseMap.aerial': 'Foto aerea',
  'hikingTrails.layer': 'Sentieri escursionistici',
  'switzerlandMobilityHiking.layer': 'A piedi SvizzeraMobile',
  'switzerlandMobilityHiking.panelAria':
    'Informazioni sull’itinerario SvizzeraMobile',
  'switzerlandMobilityHiking.close': 'Chiudi',
  'switzerlandMobilityHiking.stage': 'Tappa {number}',
  'switzerlandMobilityHiking.stageSection':
    'Tappa {number}: {section}',
  'switzerlandMobilityHiking.routeNumber': 'Itinerario {number}',
  'switzerlandMobilityHiking.unnamedRoute':
    'Itinerario escursionistico SvizzeraMobile',
  'switzerlandMobilityHiking.multipleTitle':
    'Qui passano diversi itinerari',
  'switzerlandMobilityHiking.multipleHint':
    'Scegli l’itinerario da visualizzare.',
  'switzerlandMobilityHiking.loading': 'Caricamento dell’itinerario…',
  'switzerlandMobilityHiking.loadError':
    'Non è stato possibile caricare le informazioni su questo itinerario.',
  'switzerlandMobilityHiking.elevationUnavailable':
    'Profilo altimetrico non disponibile.',
  'closures.layer': 'Chiusure / deviazioni',
  'closures.title': 'Chiusura / deviazione',
  'closures.close': 'Chiudi',
  'closures.loading': 'Caricamento delle informazioni…',
  'closures.loadError':
    'Non è stato possibile caricare le informazioni su questa chiusura.',
  'shootingDangerZones.layer': 'Avvisi di tiro / zone di pericolo',
  'shootingDangerZones.title': 'Avviso di tiro / zona di pericolo',
  'shootingDangerZones.close': 'Chiudi',
  'shootingDangerZones.loading': 'Caricamento delle informazioni…',
  'shootingDangerZones.loadError':
    'Non è stato possibile caricare le informazioni su questa zona di pericolo.',
  'transportStops.layer': 'Fermate dei trasporti pubblici',
  'transportStops.title': 'Fermata dei trasporti pubblici',
  'transportStops.close': 'Chiudi',
  'transportStops.loading': 'Caricamento delle informazioni…',
  'transportStops.loadError':
    'Non è stato possibile caricare le informazioni su questa fermata.',
  'transportStops.departures': 'Prossime partenze',
  'transportStops.departuresLoading': 'Caricamento degli orari…',
  'transportStops.departuresError':
    'Le prossime partenze non sono disponibili.',
  'transportStops.noDepartures': 'Nessuna partenza imminente trovata.',
  'transportStops.delayTitle': 'Ritardo stimato in minuti',
  'transportStops.mode.train': 'Treno',
  'transportStops.mode.metro': 'Metropolitana',
  'transportStops.mode.tram': 'Tram',
  'transportStops.mode.bus': 'Bus',
  'transportStops.mode.boat': 'Battello',
  'transportStops.mode.cableCar': 'Funivia',
  'transportStops.mode.chairlift': 'Seggiovia',
  'transportStops.mode.funicular': 'Funicolare',
  'transportStops.sbbDeparture': 'Usa come partenza su FFS',
  'transportStops.sbbDestination': 'Usa come destinazione su FFS',
  'map.zoomIn': 'Ingrandisci',
  'map.zoomOut': 'Riduci',
  'map.fullscreenEnter': 'Mostra a schermo intero',
  'map.fullscreenExit': 'Esci dallo schermo intero',
  'map.loading': 'Caricamento della carta swisstopo…',
  'map.loadFailed': 'Impossibile caricare la carta.',
  'map.tileError':
    'Il browser non è riuscito a scaricare le tessere swisstopo.',
  'map.retry':
    'Controlla la connessione Internet e ricarica la pagina.',

  'statistics.aria': 'Statistiche dell’itinerario',
  'statistics.distance': 'Distanza',
  'statistics.ascent': 'Salita',
  'statistics.descent': 'Discesa',
  'statistics.duration': 'Durata',
  'statistics.durationTitle':
    'Tempo di cammino stimato, soste escluse',
  'profile.show': 'Mostra il profilo altimetrico',
  'profile.hide': 'Nascondi il profilo altimetrico',
  'profile.loading': 'Caricamento del profilo altimetrico',
  'profile.unavailable': 'Profilo altimetrico non disponibile',
  'profile.aria': 'Profilo altimetrico dell’itinerario',
  'profile.title': 'Profilo altimetrico',
  'profile.rangeAria': 'Profilo altimetrico da {minimum} a {maximum}',

  'units.hourShort': 'h',
  'units.minuteShort': 'min',
  'gpx.routeName': 'Itinerario Via Helvetica',
  'gpx.nameLabel': 'Nome dell’itinerario',
  'gpx.nameHint':
    'Questo nome verrà usato nel file GPX e nelle applicazioni che lo importano.',
  'gpx.cancel': 'Annulla',
};

const englishTranslations: Record<TranslationKey, string> = {
  'app.title': 'Via Helvetica – Swiss Hiking Route Planner',
  'app.description':
    'Plan hiking routes in Switzerland on official maps, inspect elevation and trail information, and import or export GPX files. Free and open source.',
  'about.open': 'About Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Plan hiking routes in Switzerland on official maps.',
  'about.description':
    'Via Helvetica is a free, open-source web application. It lets you create or import a route, review its distance, elevation gain and profile, and export it as GPX.',
  'about.privacy':
    'No account is required. Routes are not stored on a server operated by Via Helvetica.',
  'about.safetyTitle': 'Important',
  'about.safety':
    'Route calculation is an experimental planning aid. Via Helvetica does not provide live navigation. Check conditions, closures, and official notices before setting out.',
  'about.projectTitle': 'Project',
  'about.createdBy': 'Created by',
  'about.support': 'Support',
  'about.sourceCode': 'Source code',
  'about.license': 'License',
  'about.linkedin': 'Professional profile',
  'about.creditsTitle': 'Maps and data',
  'about.maps': 'Maps and geodata',
  'about.switzerlandMobilityHiking': 'Hiking SwitzerlandMobility',
  'about.closures': 'Closures and detours',
  'about.dangerZones': 'Shooting notices and danger zones',
  'about.transportStops': 'Public transport stops',
  'about.departures': 'Public transport departures',
  'about.close': 'Close',
  'language.select': 'Choose language',
  'language.fr': 'French',
  'language.de': 'German',
  'language.it': 'Italian',
  'language.en': 'English',

  'search.placeholder': 'Search for a place…',
  'search.label': 'Search for a place',
  'search.clearLabel': 'Clear search',
  'search.clearTitle': 'Clear',
  'search.loading': 'Searching…',
  'search.unavailable': 'Search is temporarily unavailable.',
  'search.noResults': 'No place found.',
  'search.results': 'Search results',
  'search.category.zipcode': 'Place or postal code',
  'search.category.gg25': 'Municipality',
  'search.category.gazetteer': 'Geographic name',

  'route.toolbar': 'Route',
  'route.create': 'Create a route',
  'route.exitCreation': 'Exit route creation mode',
  'route.addFirstPoint':
    'Add a first point to choose the drawing mode',
  'route.followPaths': 'Follow hiking paths',
  'route.straightSegments': 'Add straight segments',
  'route.undoChange': 'Undo the latest change',
  'route.undo': 'Undo',
  'route.redoChange': 'Redo the latest change',
  'route.redo': 'Redo',
  'route.reverse': 'Reverse the route',
  'route.closeLoop': 'Close the loop',
  'route.openLoop': 'Open the loop',
  'route.delete': 'Delete the route',
  'route.waypointHint': 'Drag to move; click to delete.',
  'route.segmentHint': 'Click to continue, drag to insert a waypoint.',
  'route.export': 'Export the route',
  'route.import': 'Load a GPX route',
  'route.importError':
    'This GPX file does not contain a valid route.',
  'route.importTooLarge': 'This GPX file is too large.',
  'route.exportError':
    'The route must contain at least two points before it can be exported.',
  'route.noNearbyPath':
    'No swissTLM3D path was found near this point.',
  'route.noConnectedPath':
    'No connected path was found between these two points.',
  'route.areaTooLarge':
    'This segment is too long for the current dynamic loading strategy. Add an intermediate point.',
  'route.networkLoadError':
    'The swissTLM3D network for this area could not be loaded.',
  'route.hikingEnrichmentUnavailable':
    'Hiking-trail information is unavailable. For this session, routing uses only the swissTLM3D road and path network.',

  'geolocation.show': 'Show my location',
  'geolocation.recenter': 'Recenter on my location',
  'geolocation.unavailable':
    'Geolocation is not available in this browser.',
  'geolocation.searching': 'Finding your location…',
  'geolocation.outside':
    'Your location is outside the covered area.',
  'geolocation.permissionDenied':
    'Access to your location was denied.',
  'geolocation.positionUnavailable':
    'Your location could not be determined.',
  'geolocation.timeout': 'Finding your location took too long.',
  'geolocation.error': 'An error occurred while locating you.',

  'map.aria': 'Interactive Swiss national map',
  'map.controls': 'Map controls',
  'map.layers.select': 'Choose map layers',
  'map.layers.baseMaps': 'Base map',
  'map.layers.information': 'Information layers',
  'map.baseMap.color': 'Colour map',
  'map.baseMap.gray': 'Grey map',
  'map.baseMap.aerial': 'Aerial imagery',
  'hikingTrails.layer': 'Hiking trails',
  'switzerlandMobilityHiking.layer': 'Hiking SwitzerlandMobility',
  'switzerlandMobilityHiking.panelAria':
    'SwitzerlandMobility hiking route information',
  'switzerlandMobilityHiking.close': 'Close',
  'switzerlandMobilityHiking.stage': 'Stage {number}',
  'switzerlandMobilityHiking.stageSection':
    'Stage {number}: {section}',
  'switzerlandMobilityHiking.routeNumber': 'Route {number}',
  'switzerlandMobilityHiking.unnamedRoute':
    'SwitzerlandMobility hiking route',
  'switzerlandMobilityHiking.multipleTitle':
    'Several routes pass here',
  'switzerlandMobilityHiking.multipleHint':
    'Choose the route to display.',
  'switzerlandMobilityHiking.loading': 'Loading route…',
  'switzerlandMobilityHiking.loadError':
    'Information for this route could not be loaded.',
  'switzerlandMobilityHiking.elevationUnavailable':
    'Elevation profile unavailable.',
  'closures.layer': 'Closures / detours',
  'closures.title': 'Closure / detour',
  'closures.close': 'Close',
  'closures.loading': 'Loading information…',
  'closures.loadError':
    'The information for this closure could not be loaded.',
  'shootingDangerZones.layer': 'Shooting notices / danger zones',
  'shootingDangerZones.title': 'Shooting notice / danger zone',
  'shootingDangerZones.close': 'Close',
  'shootingDangerZones.loading': 'Loading information…',
  'shootingDangerZones.loadError':
    'The information for this danger zone could not be loaded.',
  'transportStops.layer': 'Public transport stops',
  'transportStops.title': 'Public transport stop',
  'transportStops.close': 'Close',
  'transportStops.loading': 'Loading information…',
  'transportStops.loadError':
    'The information for this stop could not be loaded.',
  'transportStops.departures': 'Next departures',
  'transportStops.departuresLoading': 'Loading departures…',
  'transportStops.departuresError':
    'The next departures are unavailable.',
  'transportStops.noDepartures': 'No upcoming departures found.',
  'transportStops.delayTitle': 'Estimated delay in minutes',
  'transportStops.mode.train': 'Train',
  'transportStops.mode.metro': 'Metro',
  'transportStops.mode.tram': 'Tram',
  'transportStops.mode.bus': 'Bus',
  'transportStops.mode.boat': 'Boat',
  'transportStops.mode.cableCar': 'Cable car',
  'transportStops.mode.chairlift': 'Chairlift',
  'transportStops.mode.funicular': 'Funicular',
  'transportStops.sbbDeparture': 'Use as departure on SBB',
  'transportStops.sbbDestination': 'Use as destination on SBB',
  'map.zoomIn': 'Zoom in',
  'map.zoomOut': 'Zoom out',
  'map.fullscreenEnter': 'Enter fullscreen',
  'map.fullscreenExit': 'Exit fullscreen',
  'map.loading': 'Loading the swisstopo map…',
  'map.loadFailed': 'Unable to load the map.',
  'map.tileError':
    'The browser could not download the swisstopo map tiles.',
  'map.retry': 'Check the Internet connection, then reload the page.',

  'statistics.aria': 'Route statistics',
  'statistics.distance': 'Distance',
  'statistics.ascent': 'Ascent',
  'statistics.descent': 'Descent',
  'statistics.duration': 'Duration',
  'statistics.durationTitle':
    'Estimated walking time, excluding breaks',
  'profile.show': 'Show elevation profile',
  'profile.hide': 'Hide elevation profile',
  'profile.loading': 'Loading elevation profile',
  'profile.unavailable': 'Elevation profile unavailable',
  'profile.aria': 'Route elevation profile',
  'profile.title': 'Elevation profile',
  'profile.rangeAria': 'Elevation profile from {minimum} to {maximum}',

  'units.hourShort': 'h',
  'units.minuteShort': 'min',
  'gpx.routeName': 'Via Helvetica route',
  'gpx.nameLabel': 'Route name',
  'gpx.nameHint':
    'This name will be used in the GPX file and by applications that import it.',
  'gpx.cancel': 'Cancel',
};

/** Complete translation dictionaries keyed by supported language. */
export const TRANSLATIONS: Record<
  Language,
  Record<TranslationKey, string>
> = {
  fr: frenchTranslations,
  de: germanTranslations,
  it: italianTranslations,
  en: englishTranslations,
};
