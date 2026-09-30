// Constantes de mise à jour OTA (expo-updates auto-hébergé, voir services/ota/README.md).
//
// L'URL réelle, le certificat et les en-têtes sont figés dans le binaire par app.json
// (`expo.updates`). Ce fichier ne sert qu'à l'affichage et aux garde-fous côté JS :
// il DOIT rester cohérent avec app.json.

/** Hôte du serveur OTA, sans schéma ni chemin. À renseigner avec app.json. */
export const OTA_HOST = 'OTA_HOST_A_RENSEIGNER';

/** Canal d'updates figé dans app.json (`updates.requestHeaders["expo-channel-name"]`). */
export const OTA_CHANNEL = 'production';

/** Délai minimal entre deux vérifications au lancement (évite de marteler le serveur). */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Clé AsyncStorage du dernier horodatage de vérification. */
export const LAST_CHECK_KEY = 'huwa.updates.lastCheck';

/** Vrai tant que l'hôte n'a pas été renseigné : la vérification est alors court-circuitée. */
export const OTA_CONFIGURED = !OTA_HOST.includes('A_RENSEIGNER');
