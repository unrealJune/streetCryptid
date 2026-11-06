// GENERATED from permissions.md by `just copy`. Edit the Markdown, not this file.
import type { PermissionStepId } from '@/features/social/core/permission-steps';
import type { PageCopyText, StepCopyText } from './parse-copy';

export const PERMISSIONS_PAGE_COPY: PageCopyText = {
  title: 'Permissions',
  titleSingle: 'One permission',
  subtitle:
    'We need your approval to use the following device features. You can change your mind later in Settings. streetCryptid works best with all of them, but you can skip any you want.',
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
    lede: 'streetCryptid uses your location while the app is closed or in the background.',
    cards: [
      {
        label: 'TERRITORY EXPLORATION',
        tone: 'amber',
        body: 'As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors you’ve covered. This only works if the app can sample your location occasionally in the background, since most of your moving around happens while the app is closed.',
      },
      {
        label: 'FRIEND LOCATION SHARING',
        tone: 'green',
        body: 'If you pair with friends and enable location sharing, your live location is sent so they can see you on the map, including while the app is in the background. Only friends you’ve explicitly paired with can see this.',
      },
    ],
    note: {
      ios: 'Next, your iPhone will ask to allow location access. After that, it will ask for background access.',
      default: 'Next, your device will ask you to allow location access.',
    },
    action: 'Turn on location',
  },
  'background-location': {
    name: 'Location all the time',
    title: 'Allow all the time',
    lede: 'Most of your walking happens with the app closed. Background access is what lets streetCryptid keep up then.',
    cards: [
      {
        label: 'WHILE THE APP IS CLOSED',
        tone: 'green',
        body: 'With “all the time,” your explored map keeps filling in and friends keep seeing where you are while your phone is in your pocket. With “only while using the app,” both stop the moment you leave it, and friends see a dot that stopped where you were.',
      },
    ],
    note: {
      ios: 'Next, your iPhone will ask whether to change to “Always Allow.”',
      android: 'We will open the app’s settings: choose “Allow all the time,” then come back.',
    },
    action: 'Allow all the time',
  },
  bluetooth: {
    name: 'Bluetooth',
    title: 'Bluetooth, for Bump',
    lede: 'Bump pairs two phones held together, when you’re next to a friend.',
    summary: 'Pair with your friends!',
    cards: [
      {
        label: 'PAIRING IN PERSON',
        tone: 'green',
        body: 'When you both tap Bump, each phone finds the other over Bluetooth and starts an encrypted pairing on the spot.',
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
    lede: 'When a friend is on the same Wi-Fi, your phones can talk to each other directly, minimizing network exposure and missed updates.',
    summary: 'Reach friends on the same Wi-Fi directly.',
    cards: [],
    note: {
      ios: 'Next, your iPhone will ask to find and connect to devices on your local network.',
    },
    action: 'Allow local network',
  },
  notifications: {
    name: 'Notifications',
    title: 'A notification while sharing',
    lede: 'Android shows a notification for as long as streetCryptid shares your location in the background.',
    cards: [
      {
        label: 'ALWAYS VISIBLE',
        tone: 'amber',
        body: 'We are required to show a notification while sharing your location in the background.',
      },
    ],
    note: {},
    action: 'Allow notifications',
  },
  battery: {
    name: 'Battery',
    title: 'Keep sharing when the app is closed',
    lede: 'Android sometimes stops apps in the background to save memory. When it stops streetCryptid, it won’t let sharing start again until you open the app.',
    summary: 'Unrestricted battery use',
    cards: [
      {
        label: 'SET BATTERY USE TO UNRESTRICTED',
        tone: 'green',
        body: 'This lets streetCryptid restart sharing by itself.',
      },
    ],
    note: {
      default:
        'You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll send a notification whenever sharing stops so you can turn it back on.',
    },
    action: 'Allow',
  },
};
