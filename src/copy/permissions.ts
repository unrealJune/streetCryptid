// GENERATED from permissions.md by `just copy`. Edit the Markdown, not this file.
import type { PermissionStepId } from '@/features/social/core/permission-steps';
import type { PageCopyText, StepCopyText } from './parse-copy';

export const PERMISSIONS_PAGE_COPY: PageCopyText = {
  title: 'Permissions',
  titleSingle: 'One permission',
  subtitle:
    'Here’s what streetCryptid needs, and why. It works best with everything on, but you can say no to any of it and change your mind later in Settings.',
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
    title: 'Location',
    lede: 'streetCryptid uses your location while the app is closed or in the background.',
    summary: 'Share with friends and fill in your map.',
    cards: [
      {
        label: 'FRIEND LOCATION SHARING',
        tone: 'green',
        body: 'Only friends you’ve paired with can see your location, even while the app is in the background.',
      },
      {
        label: 'TERRITORY EXPLORATION',
        tone: 'amber',
        body: 'To show where you’ve explored, the app needs your location in the background.',
      },
    ],
    note: {
      ios: 'Next, your phone will ask to allow location access, then ask again for background access.',
      default: 'Next, your phone will ask to allow location access.',
    },
    action: 'Turn on location',
  },
  'background-location': {
    name: 'Location all the time',
    title: 'Allow all the time',
    lede: 'Most of your walking happens while the app is closed. Background access lets it keep up.',
    summary: 'Keep working while the app is closed.',
    cards: [],
    note: {
      ios: 'Next, your phone will ask whether to change to “Always Allow.”',
      android: 'We’ll open your phone settings. Choose “Allow all the time,” then come back.',
    },
    action: 'Allow all the time',
  },
  bluetooth: {
    name: 'Bluetooth',
    title: 'Bluetooth for pairing',
    lede: 'Pair your phones by shaking them next to each other. It all happens over Bluetooth.',
    summary: 'Pair with a friend in person.',
    cards: [],
    note: {
      android: 'Android calls this “Nearby devices.”',
      ios: 'Next, your phone will ask to allow Bluetooth.',
    },
    action: 'Allow Bluetooth',
  },
  'local-network': {
    name: 'Local network',
    title: 'Phones on your Wi-Fi',
    lede: 'When a friend is on the same Wi-Fi, your phones can talk directly, so fewer updates go missing and less goes over the internet.',
    summary: 'Reach friends on the same Wi-Fi directly.',
    cards: [],
    note: {
      ios: 'Next, your phone will ask to find and connect to devices on your local network.',
    },
    action: 'Allow local network',
  },
  notifications: {
    name: 'Notifications',
    title: 'A notification while sharing',
    lede: 'Android requires a notification while streetCryptid uses your location in the background.',
    summary: 'Show when sharing is on.',
    cards: [
      {
        label: 'ALWAYS VISIBLE',
        tone: 'amber',
        body: 'It stays up for as long as sharing is on, so you can always tell.',
      },
    ],
    note: {},
    action: 'Allow notifications',
  },
  battery: {
    name: 'Battery',
    title: 'Keep sharing when the app is closed',
    lede: 'To keep sharing when the app is closed, set battery use to Unrestricted.',
    summary: 'Keep sharing on in the background.',
    cards: [],
    note: {
      default:
        'You can change this anytime in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll notify you whenever sharing stops so you can turn it back on.',
    },
    action: 'Allow unrestricted battery',
  },
};
