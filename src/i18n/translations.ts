/**
 * Business context: centralizes every user-facing label so the interface can
 * switch languages without scattering translation logic across map modules.
 */
import seoMetadata from './seoMetadata.json';

/** Languages supported by the application interface and GeoAdmin search. */
export const SUPPORTED_LANGUAGES = ['fr', 'de', 'it', 'en'] as const;

/** One supported interface language. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Metadata used by number formatting and the compact language controls. */
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
  'app.title': seoMetadata.fr.title,
  'app.description': seoMetadata.fr.description,
  'about.open': 'À propos de Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Planifiez vos itinéraires de randonnée en Suisse sur les cartes officielles.',
  'about.description':
    'Via Helvetica est une application web gratuite et open source. Elle permet de créer ou d’importer un itinéraire, d’en consulter la distance, le dénivelé et le profil d’altitude, puis de l’exporter au format GPX.',
  'about.privacy':
    'Aucun compte n’est nécessaire. Les itinéraires ne sont pas enregistrés sur un serveur de Via Helvetica, sauf lorsque vous choisissez le transfert vers swisstopo. Dans ce cas, le fichier GPX est hébergé pendant 24 heures, sans être associé à votre identité.',
  'about.safetyTitle': 'À savoir',
  'about.safety':
    'Les itinéraires et les données cartographiques sont fournis à titre indicatif et peuvent comporter des erreurs. Les conditions sur le terrain peuvent évoluer : vérifiez toujours les fermetures, dangers et avis officiels avant votre départ. Vous restez responsable du choix de votre itinéraire et de son adaptation à vos capacités ainsi qu’aux conditions rencontrées.',
  'about.projectTitle': 'Projet',
  'about.createdBy': 'Créé par',
  'about.support': 'Support',
  'about.sourceCode': 'Code source',
  'about.license': 'Licence',
  'about.linkedin': 'Profil professionnel',
  'about.currentVersion': 'Version actuelle',
  'about.releaseHistory': 'Historique des versions',
  'about.releaseHistoryAction': 'Consulter',
  'about.creditsTitle': 'Cartes et données',
  'about.maps': 'Cartes et géodonnées',
  'about.switzerlandMobilityHiking': 'La Suisse à pied',
  'about.closures': 'Fermetures et déviations',
  'about.dangerZones': 'Avis de tir et zones de danger',
  'about.transportStops': 'Arrêts de transports publics',
  'about.departures': 'Horaires des transports publics',
  'about.creditFederalRoadsOffice': 'OFROU',
  'about.creditSwitzerlandMobility': 'SuisseMobile',
  'about.creditHikingFederation': 'Suisse Rando',
  'about.creditCantons': 'cantons',
  'about.creditSwissArmy': 'Armée suisse',
  'about.creditFederalTransportOffice': 'OFT',
  'about.close': 'Fermer',
  'language.select': 'Choisir la langue',
  'language.fr': 'Français',
  'language.de': 'Allemand',
  'language.it': 'Italien',
  'language.en': 'Anglais',

  'search.placeholder': 'Lieu ou coordonnées…',
  'search.label': 'Rechercher un lieu ou des coordonnées',
  'search.close': 'Fermer la recherche',
  'search.clearLabel': 'Effacer la recherche',
  'search.clearTitle': 'Effacer',
  'search.loading': 'Recherche…',
  'search.unavailable': 'La recherche est momentanément indisponible.',
  'search.noResults': 'Aucun lieu trouvé.',
  'search.coordinatesOutside':
    'Ces coordonnées se trouvent hors de la zone couverte par la carte.',
  'search.results': 'Résultats de recherche',
  'search.category.zipcode': 'Localité ou code postal',
  'search.category.gg25': 'Commune',
  'search.category.gazetteer': 'Nom géographique',
  'search.category.wgs84': 'Coordonnées WGS 84',
  'search.category.lv95': 'Coordonnées LV95',

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
  'route.editImported': 'Modifier l’itinéraire',
  'route.editImportedSingleSegmentOnly':
    'L’édition est disponible uniquement pour les GPX contenant un seul tronçon continu.',
  'route.editImportedOutsideMap':
    'Cet itinéraire sort de la zone couverte par Via Helvetica et ne peut pas être modifié.',
  'route.editImportedTooManyPoints':
    'Ce GPX contient plus de {maximum} points. Il peut être affiché, mais il est trop détaillé pour être modifié dans cette version.',
  'route.editImportedSparseGeometry':
    'Ce GPX ne contient pas assez de points intermédiaires pour rester modifiable avec le suivi des chemins (maximum {maximum} km entre deux points). Il reste disponible en lecture seule.',
  'route.editImportedError':
    'Cet itinéraire GPX n’a pas pu être préparé pour l’édition.',
  'route.importError':
    'Ce fichier GPX ne contient pas d’itinéraire valide.',
  'route.importTooLarge': 'Ce fichier GPX est trop volumineux.',
  'route.exportError':
    'L’itinéraire doit contenir au moins deux points pour être exporté.',
  'route.noNearbyPath':
    'Aucun chemin swissTLM3D n’a été trouvé à proximité de ce point.',
  'route.noConnectedPath':
    'Aucun chemin connecté n’a été trouvé entre ces deux points.',
  'route.sectionTooLong':
    'Cette section ferait {distance} km à vol d’oiseau. Ajoutez un point intermédiaire : le suivi des chemins est limité à {maximum} km entre deux points.',
  'route.areaTooLarge':
    'Ce segment est trop long pour le chargement dynamique actuel. Ajoutez un point intermédiaire.',
  'route.networkLoadError':
    'Le réseau swissTLM3D de cette zone n’a pas pu être chargé.',
  'route.hikingEnrichmentUnavailable':
    'Les informations sur les chemins de randonnée sont indisponibles. Pour cette session, le routage utilise uniquement le réseau de routes et de chemins swissTLM3D.',
  'route.precomputedRoutingUnavailable':
    'Les données de routage prétraitées sont indisponibles. Pour cette session, Via Helvetica utilise le service de routage GeoAdmin de secours.',

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
  'map.layers.mobileTitle': 'Carte et options',
  'map.layers.close': 'Fermer le panneau Carte et options',
  'map.layers.baseMaps': 'Fond de carte',
  'map.layers.information': 'Couches d’information',
  'map.layers.language': 'Langue',
  'map.layers.opacity': 'Opacité',
  'map.layers.adjustOpacity': 'Régler l’opacité de la couche « {layer} »',
  'mapInformationChoice.title': 'Informations à cet endroit',
  'mapInformationChoice.hint': 'Plusieurs informations se trouvent ici. Choisissez celle à consulter.',
  'mapInformationChoice.safety': 'Randonnée et sécurité',
  'mapInformationChoice.close': 'Fermer',
  'mapPosition.title': 'Position sur la carte',
  'mapPosition.wgs84': 'WGS 84',
  'mapPosition.lv95': 'LV95',
  'mapPosition.altitude': 'Altitude',
  'mapPosition.altitudeLoading': 'Chargement…',
  'mapPosition.altitudeUnavailable': 'Altitude indisponible',
  'mapPosition.copyWgs84': 'Copier les coordonnées WGS 84',
  'mapPosition.copyLv95': 'Copier les coordonnées LV95',
  'mapPosition.close': 'Fermer',
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
  'gpx.close': 'Fermer',
  'gpx.download': 'Exporter le fichier GPX',
  'gpx.createSwisstopoQr': 'Créer un QR code pour importer dans swisstopo',
  'gpx.openSwisstopoApp': 'Ouvrir dans l’application swisstopo',
  'gpx.prepareSwisstopoMobile': 'Préparer l’ouverture dans swisstopo',
  'gpx.swisstopoStorageNotice':
    'Pour le transfert vers swisstopo, le fichier GPX est hébergé pendant 24 heures, sans être associé à votre identité.',
  'gpx.preparingSwisstopo': 'Préparation…',
  'gpx.swisstopoReady': 'Itinéraire prêt pour swisstopo',
  'gpx.swisstopoScanHint':
    'Scannez ce code QR avec votre téléphone pour ouvrir l’itinéraire dans l’app swisstopo.',
  'gpx.swisstopoQrAria': 'Code QR pour ouvrir l’itinéraire dans swisstopo',
  'gpx.swisstopoTooLarge':
    'Cet itinéraire dépasse la limite de 2 Mo pour le transfert vers swisstopo. Exportez le fichier GPX à la place.',
  'gpx.swisstopoUnsupported':
    'Ce fichier GPX peut être affiché dans Via Helvetica, mais son format ne peut pas être transféré vers swisstopo.',
  'gpx.swisstopoError':
    'Impossible de préparer l’itinéraire pour swisstopo. Réessayez.',
} as const;

/** Translation keys accepted by the typed `t()` helper. */
export type TranslationKey = keyof typeof frenchTranslations;

const germanTranslations: Record<TranslationKey, string> = {
  'app.title': seoMetadata.de.title,
  'app.description': seoMetadata.de.description,
  'about.open': 'Über Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Planen Sie Wanderungen in der Schweiz auf offiziellen Karten.',
  'about.description':
    'Via Helvetica ist eine kostenlose Open-Source-Webanwendung. Sie können eine Route erstellen oder importieren, Distanz, Höhenunterschiede und Höhenprofil prüfen und die Route als GPX exportieren.',
  'about.privacy':
    'Es ist kein Konto erforderlich. Routen werden nicht auf einem Server von Via Helvetica gespeichert, ausser wenn Sie die Übertragung zu swisstopo wählen. In diesem Fall wird die GPX-Datei 24 Stunden lang gehostet, ohne mit Ihrer Identität verknüpft zu werden.',
  'about.safetyTitle': 'Hinweis',
  'about.safety':
    'Die vorgeschlagenen Routen und Kartendaten dienen nur zur Orientierung und können Fehler enthalten. Die Bedingungen vor Ort können sich ändern: Prüfen Sie vor dem Aufbruch stets Sperrungen, Gefahren und offizielle Hinweise. Sie sind selbst dafür verantwortlich, Ihre Route auszuwählen und sie an Ihre Fähigkeiten sowie die vorgefundenen Bedingungen anzupassen.',
  'about.projectTitle': 'Projekt',
  'about.createdBy': 'Erstellt von',
  'about.support': 'Support',
  'about.sourceCode': 'Quellcode',
  'about.license': 'Lizenz',
  'about.linkedin': 'Berufsprofil',
  'about.currentVersion': 'Aktuelle Version',
  'about.releaseHistory': 'Versionsverlauf',
  'about.releaseHistoryAction': 'Ansehen',
  'about.creditsTitle': 'Karten und Daten',
  'about.maps': 'Karten und Geodaten',
  'about.switzerlandMobilityHiking': 'Wanderland',
  'about.closures': 'Sperrungen und Umleitungen',
  'about.dangerZones': 'Schiessanzeigen und Gefahrenzonen',
  'about.transportStops': 'Haltestellen des öffentlichen Verkehrs',
  'about.departures': 'Fahrplandaten',
  'about.creditFederalRoadsOffice': 'ASTRA',
  'about.creditSwitzerlandMobility': 'SchweizMobil',
  'about.creditHikingFederation': 'Schweizer Wanderwege',
  'about.creditCantons': 'Kantone',
  'about.creditSwissArmy': 'Schweizer Armee',
  'about.creditFederalTransportOffice': 'BAV',
  'about.close': 'Schliessen',
  'language.select': 'Sprache wählen',
  'language.fr': 'Französisch',
  'language.de': 'Deutsch',
  'language.it': 'Italienisch',
  'language.en': 'Englisch',

  'search.placeholder': 'Ort oder Koordinaten…',
  'search.label': 'Ort oder Koordinaten suchen',
  'search.close': 'Suche schliessen',
  'search.clearLabel': 'Suche löschen',
  'search.clearTitle': 'Löschen',
  'search.loading': 'Suche…',
  'search.unavailable': 'Die Suche ist vorübergehend nicht verfügbar.',
  'search.noResults': 'Kein Ort gefunden.',
  'search.coordinatesOutside':
    'Diese Koordinaten liegen ausserhalb des Kartenbereichs.',
  'search.results': 'Suchergebnisse',
  'search.category.zipcode': 'Ort oder Postleitzahl',
  'search.category.gg25': 'Gemeinde',
  'search.category.gazetteer': 'Geografischer Name',
  'search.category.wgs84': 'WGS-84-Koordinaten',
  'search.category.lv95': 'LV95-Koordinaten',

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
  'route.editImported': 'Route bearbeiten',
  'route.editImportedSingleSegmentOnly':
    'Die Bearbeitung ist nur für GPX-Dateien mit einem einzigen durchgehenden Abschnitt verfügbar.',
  'route.editImportedOutsideMap':
    'Diese Route liegt teilweise ausserhalb des von Via Helvetica abgedeckten Gebiets und kann nicht bearbeitet werden.',
  'route.editImportedTooManyPoints':
    'Diese GPX-Datei enthält mehr als {maximum} Punkte. Sie kann angezeigt werden, ist in dieser Version aber zu detailliert für die Bearbeitung.',
  'route.editImportedSparseGeometry':
    'Diese GPX-Datei enthält nicht genügend Zwischenpunkte, um mit Wegführung bearbeitet zu werden (höchstens {maximum} km zwischen zwei Punkten). Sie bleibt schreibgeschützt verfügbar.',
  'route.editImportedError':
    'Diese GPX-Route konnte nicht für die Bearbeitung vorbereitet werden.',
  'route.importError':
    'Diese GPX-Datei enthält keine gültige Route.',
  'route.importTooLarge': 'Diese GPX-Datei ist zu gross.',
  'route.exportError':
    'Die Route muss mindestens zwei Punkte enthalten, damit sie exportiert werden kann.',
  'route.noNearbyPath':
    'In der Nähe dieses Punkts wurde kein swissTLM3D-Weg gefunden.',
  'route.noConnectedPath':
    'Zwischen diesen beiden Punkten wurde kein verbundener Weg gefunden.',
  'route.sectionTooLong':
    'Dieser Abschnitt wäre in Luftlinie {distance} km lang. Fügen Sie einen Zwischenpunkt hinzu: Die Wegführung ist zwischen zwei Punkten auf {maximum} km begrenzt.',
  'route.areaTooLarge':
    'Dieses Segment ist für das aktuelle dynamische Laden zu lang. Fügen Sie einen Zwischenpunkt hinzu.',
  'route.networkLoadError':
    'Das swissTLM3D-Netz in diesem Gebiet konnte nicht geladen werden.',
  'route.hikingEnrichmentUnavailable':
    'Die Wanderweg-Informationen sind nicht verfügbar. Für diese Sitzung verwendet die Routenberechnung nur das swissTLM3D-Strassen- und Wegenetz.',
  'route.precomputedRoutingUnavailable':
    'Die vorverarbeiteten Routingdaten sind nicht verfügbar. Für diese Sitzung verwendet Via Helvetica ersatzweise den GeoAdmin-Routingdienst.',

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
  'map.layers.mobileTitle': 'Karte und Optionen',
  'map.layers.close': 'Karte und Optionen schliessen',
  'map.layers.baseMaps': 'Kartenhintergrund',
  'map.layers.information': 'Informationsebenen',
  'map.layers.language': 'Sprache',
  'map.layers.opacity': 'Deckkraft',
  'map.layers.adjustOpacity': 'Deckkraft der Ebene „{layer}“ einstellen',
  'mapInformationChoice.title': 'Informationen an dieser Stelle',
  'mapInformationChoice.hint': 'Hier sind mehrere Informationen verfügbar. Wählen Sie aus, was Sie ansehen möchten.',
  'mapInformationChoice.safety': 'Wandern und Sicherheit',
  'mapInformationChoice.close': 'Schliessen',
  'mapPosition.title': 'Position auf der Karte',
  'mapPosition.wgs84': 'WGS 84',
  'mapPosition.lv95': 'LV95',
  'mapPosition.altitude': 'Höhe',
  'mapPosition.altitudeLoading': 'Wird geladen…',
  'mapPosition.altitudeUnavailable': 'Höhe nicht verfügbar',
  'mapPosition.copyWgs84': 'WGS-84-Koordinaten kopieren',
  'mapPosition.copyLv95': 'LV95-Koordinaten kopieren',
  'mapPosition.close': 'Schliessen',
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
  'gpx.close': 'Schliessen',
  'gpx.download': 'GPX-Datei exportieren',
  'gpx.createSwisstopoQr': 'QR-Code zum Import in swisstopo erstellen',
  'gpx.openSwisstopoApp': 'In der swisstopo-App öffnen',
  'gpx.prepareSwisstopoMobile': 'Öffnen in swisstopo vorbereiten',
  'gpx.swisstopoStorageNotice':
    'Für die Übertragung zu swisstopo wird die GPX-Datei 24 Stunden lang bereitgestellt, ohne mit Ihrer Identität verknüpft zu werden.',
  'gpx.preparingSwisstopo': 'Wird vorbereitet…',
  'gpx.swisstopoReady': 'Route für swisstopo bereit',
  'gpx.swisstopoScanHint':
    'Scannen Sie diesen QR-Code mit Ihrem Telefon, um die Route in der swisstopo-App zu öffnen.',
  'gpx.swisstopoQrAria': 'QR-Code zum Öffnen der Route in swisstopo',
  'gpx.swisstopoTooLarge':
    'Diese Route überschreitet die 2-MB-Grenze für die Übertragung zu swisstopo. Exportieren Sie stattdessen die GPX-Datei.',
  'gpx.swisstopoUnsupported':
    'Diese GPX-Datei kann in Via Helvetica angezeigt, in diesem Format aber nicht an swisstopo übertragen werden.',
  'gpx.swisstopoError':
    'Die Route konnte nicht für swisstopo vorbereitet werden. Versuchen Sie es erneut.',
};

const italianTranslations: Record<TranslationKey, string> = {
  'app.title': seoMetadata.it.title,
  'app.description': seoMetadata.it.description,
  'about.open': 'Informazioni su Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Pianifica itinerari escursionistici in Svizzera sulle carte ufficiali.',
  'about.description':
    'Via Helvetica è un’applicazione web gratuita e open source. Permette di creare o importare un itinerario, consultarne distanza, dislivello e profilo altimetrico, quindi esportarlo in formato GPX.',
  'about.privacy':
    'Non è necessario alcun account. Gli itinerari non vengono salvati su un server di Via Helvetica, salvo quando scegli il trasferimento a swisstopo. In questo caso, il file GPX viene ospitato per 24 ore senza essere associato alla tua identità.',
  'about.safetyTitle': 'Da sapere',
  'about.safety':
    'Gli itinerari e i dati cartografici sono forniti a titolo indicativo e possono contenere errori. Le condizioni sul terreno possono cambiare: prima di partire, verifica sempre chiusure, pericoli e avvisi ufficiali. Sei responsabile della scelta del tuo itinerario e del suo adattamento alle tue capacità e alle condizioni incontrate.',
  'about.projectTitle': 'Progetto',
  'about.createdBy': 'Creato da',
  'about.support': 'Supporto',
  'about.sourceCode': 'Codice sorgente',
  'about.license': 'Licenza',
  'about.linkedin': 'Profilo professionale',
  'about.currentVersion': 'Versione attuale',
  'about.releaseHistory': 'Cronologia delle versioni',
  'about.releaseHistoryAction': 'Consulta',
  'about.creditsTitle': 'Carte e dati',
  'about.maps': 'Carte e geodati',
  'about.switzerlandMobilityHiking': 'La Svizzera a piedi',
  'about.closures': 'Chiusure e deviazioni',
  'about.dangerZones': 'Avvisi di tiro e zone di pericolo',
  'about.transportStops': 'Fermate dei trasporti pubblici',
  'about.departures': 'Orari dei trasporti pubblici',
  'about.creditFederalRoadsOffice': 'USTRA',
  'about.creditSwitzerlandMobility': 'SvizzeraMobile',
  'about.creditHikingFederation': 'Sentieri Svizzeri',
  'about.creditCantons': 'cantoni',
  'about.creditSwissArmy': 'Esercito svizzero',
  'about.creditFederalTransportOffice': 'UFT',
  'about.close': 'Chiudi',
  'language.select': 'Scegli la lingua',
  'language.fr': 'Francese',
  'language.de': 'Tedesco',
  'language.it': 'Italiano',
  'language.en': 'Inglese',

  'search.placeholder': 'Luogo o coordinate…',
  'search.label': 'Cerca un luogo o delle coordinate',
  'search.close': 'Chiudi la ricerca',
  'search.clearLabel': 'Cancella la ricerca',
  'search.clearTitle': 'Cancella',
  'search.loading': 'Ricerca…',
  'search.unavailable': 'La ricerca non è momentaneamente disponibile.',
  'search.noResults': 'Nessuna località trovata.',
  'search.coordinatesOutside':
    'Queste coordinate si trovano fuori dall’area coperta dalla carta.',
  'search.results': 'Risultati della ricerca',
  'search.category.zipcode': 'Località o codice postale',
  'search.category.gg25': 'Comune',
  'search.category.gazetteer': 'Nome geografico',
  'search.category.wgs84': 'Coordinate WGS 84',
  'search.category.lv95': 'Coordinate LV95',

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
  'route.editImported': 'Modifica l’itinerario',
  'route.editImportedSingleSegmentOnly':
    'La modifica è disponibile solo per i GPX con un unico tratto continuo.',
  'route.editImportedOutsideMap':
    'Questo itinerario esce dall’area coperta da Via Helvetica e non può essere modificato.',
  'route.editImportedTooManyPoints':
    'Questo GPX contiene più di {maximum} punti. Può essere visualizzato, ma in questa versione è troppo dettagliato per essere modificato.',
  'route.editImportedSparseGeometry':
    'Questo GPX non contiene abbastanza punti intermedi per restare modificabile seguendo i sentieri (massimo {maximum} km tra due punti). Rimane disponibile in sola lettura.',
  'route.editImportedError':
    'Non è stato possibile preparare questo itinerario GPX per la modifica.',
  'route.importError':
    'Questo file GPX non contiene un itinerario valido.',
  'route.importTooLarge': 'Questo file GPX è troppo grande.',
  'route.exportError':
    'L’itinerario deve contenere almeno due punti per poter essere esportato.',
  'route.noNearbyPath':
    'Nessun percorso swissTLM3D è stato trovato vicino a questo punto.',
  'route.noConnectedPath':
    'Nessun percorso collegato è stato trovato tra questi due punti.',
  'route.sectionTooLong':
    'Questo tratto sarebbe lungo {distance} km in linea d’aria. Aggiungi un punto intermedio: il calcolo sui sentieri è limitato a {maximum} km tra due punti.',
  'route.areaTooLarge':
    'Questo segmento è troppo lungo per il caricamento dinamico attuale. Aggiungi un punto intermedio.',
  'route.networkLoadError':
    'Non è stato possibile caricare la rete swissTLM3D di questa zona.',
  'route.hikingEnrichmentUnavailable':
    'Le informazioni sui sentieri escursionistici non sono disponibili. Per questa sessione, il calcolo del percorso utilizza soltanto la rete di strade e sentieri swissTLM3D.',
  'route.precomputedRoutingUnavailable':
    'I dati di routing preelaborati non sono disponibili. Per questa sessione, Via Helvetica utilizza il servizio di routing GeoAdmin di riserva.',

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
  'map.layers.mobileTitle': 'Mappa e opzioni',
  'map.layers.close': 'Chiudi il pannello Mappa e opzioni',
  'map.layers.baseMaps': 'Sfondo della carta',
  'map.layers.information': 'Livelli informativi',
  'map.layers.language': 'Lingua',
  'map.layers.opacity': 'Opacità',
  'map.layers.adjustOpacity': 'Regola l’opacità del livello « {layer} »',
  'mapInformationChoice.title': 'Informazioni in questo punto',
  'mapInformationChoice.hint': 'Qui sono disponibili più informazioni. Scegli quella da consultare.',
  'mapInformationChoice.safety': 'Escursionismo e sicurezza',
  'mapInformationChoice.close': 'Chiudi',
  'mapPosition.title': 'Posizione sulla carta',
  'mapPosition.wgs84': 'WGS 84',
  'mapPosition.lv95': 'LV95',
  'mapPosition.altitude': 'Altitudine',
  'mapPosition.altitudeLoading': 'Caricamento…',
  'mapPosition.altitudeUnavailable': 'Altitudine non disponibile',
  'mapPosition.copyWgs84': 'Copia le coordinate WGS 84',
  'mapPosition.copyLv95': 'Copia le coordinate LV95',
  'mapPosition.close': 'Chiudi',
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
  'gpx.close': 'Chiudi',
  'gpx.download': 'Esporta il file GPX',
  'gpx.createSwisstopoQr': 'Crea un codice QR per importare in swisstopo',
  'gpx.openSwisstopoApp': 'Apri nell’app swisstopo',
  'gpx.prepareSwisstopoMobile': 'Prepara l’apertura in swisstopo',
  'gpx.swisstopoStorageNotice':
    'Per il trasferimento a swisstopo, il file GPX viene ospitato per 24 ore senza essere associato alla tua identità.',
  'gpx.preparingSwisstopo': 'Preparazione…',
  'gpx.swisstopoReady': 'Itinerario pronto per swisstopo',
  'gpx.swisstopoScanHint':
    'Scansiona questo codice QR con il telefono per aprire l’itinerario nell’app swisstopo.',
  'gpx.swisstopoQrAria': 'Codice QR per aprire l’itinerario in swisstopo',
  'gpx.swisstopoTooLarge':
    'Questo itinerario supera il limite di 2 MB per il trasferimento a swisstopo. Esporta invece il file GPX.',
  'gpx.swisstopoUnsupported':
    'Questo file GPX può essere visualizzato in Via Helvetica, ma il suo formato non può essere trasferito a swisstopo.',
  'gpx.swisstopoError':
    'Impossibile preparare l’itinerario per swisstopo. Riprova.',
};

const englishTranslations: Record<TranslationKey, string> = {
  'app.title': seoMetadata.en.title,
  'app.description': seoMetadata.en.description,
  'about.open': 'About Via Helvetica',
  'about.title': 'Via Helvetica',
  'about.tagline':
    'Plan hiking routes in Switzerland on official maps.',
  'about.description':
    'Via Helvetica is a free, open-source web application. It lets you create or import a route, review its distance, elevation gain and profile, and export it as GPX.',
  'about.privacy':
    'No account is required. Routes are not stored on a Via Helvetica server unless you choose the swisstopo transfer. In that case, the GPX file is hosted for 24 hours without being associated with your identity.',
  'about.safetyTitle': 'Important',
  'about.safety':
    'Routes and map data are provided for guidance only and may contain errors. Conditions on the ground can change: always check closures, hazards, and official notices before setting out. You remain responsible for choosing your route and adapting it to your abilities and the conditions encountered.',
  'about.projectTitle': 'Project',
  'about.createdBy': 'Created by',
  'about.support': 'Support',
  'about.sourceCode': 'Source code',
  'about.license': 'License',
  'about.linkedin': 'Professional profile',
  'about.currentVersion': 'Current version',
  'about.releaseHistory': 'Release history',
  'about.releaseHistoryAction': 'View',
  'about.creditsTitle': 'Maps and data',
  'about.maps': 'Maps and geodata',
  'about.switzerlandMobilityHiking': 'Hiking in Switzerland',
  'about.closures': 'Closures and detours',
  'about.dangerZones': 'Shooting notices and danger zones',
  'about.transportStops': 'Public transport stops',
  'about.departures': 'Public transport departures',
  'about.creditFederalRoadsOffice': 'FEDRO',
  'about.creditSwitzerlandMobility': 'SwitzerlandMobility',
  'about.creditHikingFederation': 'Swiss Hiking Trail Federation',
  'about.creditCantons': 'cantons',
  'about.creditSwissArmy': 'Swiss Armed Forces',
  'about.creditFederalTransportOffice': 'FOT',
  'about.close': 'Close',
  'language.select': 'Choose language',
  'language.fr': 'French',
  'language.de': 'German',
  'language.it': 'Italian',
  'language.en': 'English',

  'search.placeholder': 'Place or coordinates…',
  'search.label': 'Search for a place or coordinates',
  'search.close': 'Close search',
  'search.clearLabel': 'Clear search',
  'search.clearTitle': 'Clear',
  'search.loading': 'Searching…',
  'search.unavailable': 'Search is temporarily unavailable.',
  'search.noResults': 'No place found.',
  'search.coordinatesOutside':
    'These coordinates are outside the area covered by the map.',
  'search.results': 'Search results',
  'search.category.zipcode': 'Place or postal code',
  'search.category.gg25': 'Municipality',
  'search.category.gazetteer': 'Geographic name',
  'search.category.wgs84': 'WGS 84 coordinates',
  'search.category.lv95': 'LV95 coordinates',

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
  'route.editImported': 'Edit the route',
  'route.editImportedSingleSegmentOnly':
    'Editing is available only for GPX files containing one continuous segment.',
  'route.editImportedOutsideMap':
    'This route extends outside the area covered by Via Helvetica and cannot be edited.',
  'route.editImportedTooManyPoints':
    'This GPX contains more than {maximum} points. It can still be displayed, but it is too detailed to edit in this version.',
  'route.editImportedSparseGeometry':
    'This GPX does not contain enough intermediate points to remain editable with path-following (maximum {maximum} km between two points). It remains available read-only.',
  'route.editImportedError':
    'This GPX route could not be prepared for editing.',
  'route.importError':
    'This GPX file does not contain a valid route.',
  'route.importTooLarge': 'This GPX file is too large.',
  'route.exportError':
    'The route must contain at least two points before it can be exported.',
  'route.noNearbyPath':
    'No swissTLM3D path was found near this point.',
  'route.noConnectedPath':
    'No connected path was found between these two points.',
  'route.sectionTooLong':
    'This section would be {distance} km as the crow flies. Add an intermediate waypoint: path-following is limited to {maximum} km between two points.',
  'route.areaTooLarge':
    'This segment is too long for the current dynamic loading strategy. Add an intermediate point.',
  'route.networkLoadError':
    'The swissTLM3D network for this area could not be loaded.',
  'route.hikingEnrichmentUnavailable':
    'Hiking-trail information is unavailable. For this session, routing uses only the swissTLM3D road and path network.',
  'route.precomputedRoutingUnavailable':
    'Preprocessed routing data is unavailable. For this session, Via Helvetica is using the GeoAdmin fallback routing service.',

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
  'map.layers.mobileTitle': 'Map and options',
  'map.layers.close': 'Close Map and options panel',
  'map.layers.baseMaps': 'Base map',
  'map.layers.information': 'Information layers',
  'map.layers.language': 'Language',
  'map.layers.opacity': 'Opacity',
  'map.layers.adjustOpacity': 'Adjust opacity for the “{layer}” layer',
  'mapInformationChoice.title': 'Information at this location',
  'mapInformationChoice.hint': 'Several items are available here. Choose what you want to inspect.',
  'mapInformationChoice.safety': 'Hiking and safety',
  'mapInformationChoice.close': 'Close',
  'mapPosition.title': 'Map position',
  'mapPosition.wgs84': 'WGS 84',
  'mapPosition.lv95': 'LV95',
  'mapPosition.altitude': 'Elevation',
  'mapPosition.altitudeLoading': 'Loading…',
  'mapPosition.altitudeUnavailable': 'Elevation unavailable',
  'mapPosition.copyWgs84': 'Copy WGS 84 coordinates',
  'mapPosition.copyLv95': 'Copy LV95 coordinates',
  'mapPosition.close': 'Close',
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
  'gpx.close': 'Close',
  'gpx.download': 'Export the GPX file',
  'gpx.createSwisstopoQr': 'Create a QR code to import into swisstopo',
  'gpx.openSwisstopoApp': 'Open in the swisstopo app',
  'gpx.prepareSwisstopoMobile': 'Prepare to open in swisstopo',
  'gpx.swisstopoStorageNotice':
    'For the swisstopo transfer, the GPX file is hosted for 24 hours without being associated with your identity.',
  'gpx.preparingSwisstopo': 'Preparing…',
  'gpx.swisstopoReady': 'Route ready for swisstopo',
  'gpx.swisstopoScanHint':
    'Scan this QR code with your phone to open the route in the swisstopo app.',
  'gpx.swisstopoQrAria': 'QR code for opening the route in swisstopo',
  'gpx.swisstopoTooLarge':
    'This route exceeds the 2 MB limit for transfer to swisstopo. Export the GPX file instead.',
  'gpx.swisstopoUnsupported':
    'This GPX file can be displayed in Via Helvetica, but its format cannot be transferred to swisstopo.',
  'gpx.swisstopoError':
    'The route could not be prepared for swisstopo. Please try again.',
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
