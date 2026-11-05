// GENERATED from permissions.md by `just copy`. Edit the Markdown, not this file.
import type { PermissionStepId } from '../core/permission-steps';
import type { PageCopyText, StepCopyText } from './parse-copy';

export const PERMISSIONS_PAGE_COPY: PageCopyText = {
  title: 'A few permissions',
  titleSingle: 'One permission',
  subtitle:
    'Each one says what it’s for before your phone asks. Every one is optional, and you can change any of them later in your phone’s settings.',
  continue: 'Continue',
  notNow: 'Not now',
  railOk: 'OK',
  outcome: {
    allowed: 'ALLOWED',
    refused: 'NOT ALLOWED',
    asked: 'ASKED',
    declined: 'NOT NOW',
    skipped: 'SKIPPED',
  },
};

export const PERMISSION_STEP_COPY: Record<PermissionStepId, StepCopyText> = {
  location: {
    name: 'Location',
    title: 'Before we turn on location',
    lede: 'streetCryptid uses your location — including while the app is closed or in the background — for two things. Here’s exactly what and why.',
    summary: 'Location — to reveal the streets you walk and share your position with friends.',
    cards: [
      {
        label: 'TERRITORY EXPLORATION',
        tone: 'amber',
        body: 'As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors you’ve actually covered — building your personal explored map. This only works if the app can sample your location occasionally in the background, since most of your walking happens while the app is closed.',
      },
      {
        label: 'FRIEND LOCATION SHARING',
        tone: 'green',
        body: 'If you pair with friends, your live location syncs directly to their devices — end-to-end encrypted — so they can see you on the map, including while the app is in the background. Only friends you’ve explicitly paired with can see this.',
      },
    ],
    note: {
      ios: 'Next, your iPhone will ask to allow location access. The step after this one asks for background access.',
      default:
        'Next, your device will ask you to allow location access, and the step after this one asks for “Allow all the time.” Choosing “Not now” keeps streetCryptid working, minus background exploration and friend sharing — you can turn it on later from Settings.',
    },
    action: 'Turn on location',
  },
  'background-location': {
    name: 'Location all the time',
    title: 'Allow all the time',
    lede: 'Most of your walking happens with the app closed. Background access is what lets streetCryptid keep up then.',
    summary: 'Location all the time — so it keeps working while the app is closed.',
    cards: [
      {
        label: 'WHILE THE APP IS CLOSED',
        tone: 'green',
        body: 'With “all the time,” your explored map keeps filling in and friends keep seeing where you are while your phone is in your pocket. With “only while using the app,” both stop the moment you leave it, and friends see a dot that stopped where you were.',
      },
    ],
    note: {
      ios: 'Next, your iPhone will ask whether to change to “Always Allow.”',
      android: 'Android opens Settings for this one: choose “Allow all the time,” then come back.',
    },
    action: 'Allow all the time',
  },
  bluetooth: {
    name: 'Bluetooth',
    title: 'Bluetooth, for Bump',
    lede: 'Bump pairs two phones held together, with no link to send and no account to look up.',
    summary: 'Bluetooth — to find a friend’s phone when you Bump.',
    cards: [
      {
        label: 'PAIRING IN PERSON',
        tone: 'green',
        body: 'When you both tap Bump, each phone finds the other over Bluetooth and starts an encrypted pairing on the spot — it works with no signal at all. Without Bluetooth you can still pair by sending a link.',
      },
    ],
    note: {
      android: 'Android calls this “Nearby devices.”',
      ios: 'Next, your iPhone will ask to allow Bluetooth.',
    },
    action: 'Allow Bluetooth',
  },
  'local-network': {
    name: 'Local network',
    title: 'Phones on your Wi-Fi',
    lede: 'When a friend is on the same Wi-Fi, your phones can talk to each other directly.',
    summary: 'Local network — to reach friends on the same Wi-Fi directly.',
    cards: [
      {
        label: 'THE SHORT WAY ROUND',
        tone: 'green',
        body: 'Directly is faster than going through a relay, and it keeps working when the internet doesn’t. Without it nothing breaks — your location still reaches friends, just the long way.',
      },
    ],
    note: {
      ios: 'Next, your iPhone will ask to find and connect to devices on your local network.',
    },
    action: 'Allow local network',
  },
  notifications: {
    name: 'Notifications',
    title: 'A notification while sharing',
    lede: 'Android shows a notification for as long as streetCryptid shares your location in the background.',
    summary: 'Notifications — so you can always see that sharing is on.',
    cards: [
      {
        label: 'ALWAYS VISIBLE',
        tone: 'amber',
        body: 'It’s how you can tell at a glance that sharing is on, and if Android ever stops it, it’s how we let you know. Sharing works either way; without this you just can’t see it.',
      },
    ],
    note: {},
    action: 'Allow notifications',
  },
  battery: {
    name: 'Battery',
    title: 'Keep sharing when the app is closed',
    lede: 'Android sometimes stops apps in the background to save memory. When it stops streetCryptid, it won’t let sharing start again until you open the app — so your friends see a dot that stopped hours ago.',
    summary: 'Unrestricted battery use — so Android can’t switch sharing off for good.',
    cards: [
      {
        label: 'SET BATTERY USE TO UNRESTRICTED',
        tone: 'green',
        body: 'This lets streetCryptid restart sharing by itself. It doesn’t make the app check your location any more often — it only stops Android from switching sharing off for good.',
      },
    ],
    note: {
      default:
        'You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll send a notification whenever sharing stops so you can turn it back on.',
    },
    action: 'Allow',
  },
};
