/**
 * The cryptid roster: every creature the app can hand you, in one table.
 *
 * Two things read this. `random-persona.ts` rolls one at a time for the profile
 * editor; `cryptid-generator.ts` matches a typed description against `keywords`
 * when the on-device model is unavailable and the offline maker has to draw. They
 * used to keep two near-identical copies of this table, which meant a new cryptid
 * had to be added twice and the two drifted.
 *
 * Every entry is a NAMED species, not a silhouette with interchangeable nouns. A
 * roll is meant to hand you something you can recognise — "Fogbound Mothman", not
 * "Fogbound Shuck" from a shape that is equally a Hound and a Howler. Variety comes
 * from the title prefix, the eye and mouth substitution, and the signal colour.
 *
 * ## What the drawing has to fit
 *
 * `validateCryptidProfileFields` in `./profile` is the hard gate: ASCII only, at
 * most `MAX_SIGIL_LINES` lines and `MAX_SIGIL_COLUMNS` columns. But the real
 * constraint is smaller and is not enforced there — on the map the sigil is packed
 * into a ~52x38pt box by `sigilMetrics`, which clamps the font to 3-7px:
 *
 *     <= 4 lines and <= 12 columns  ->  the full 7px, as large as a marker ever gets
 *     5 lines                       ->  6.8px
 *     6 lines                       ->  5.6px
 *     > 7 lines or > 18 columns     ->  under 4.5px, where it stops reading as a face
 *
 * So a compact drawing is literally bigger on the map than a sprawling one.
 * `cryptid-forms.test.ts` asserts the 4.5px floor; `just cryptid-preview` renders
 * the whole roster at that exact size so the cost of a tall creature is visible
 * rather than theoretical.
 *
 * ## Naming
 *
 * A creature name is capped at 14 characters, which is not a style rule: the
 * profile name caps at 24 and the longest `TITLE` in `random-persona.ts` is 9
 * plus a space. `Loveland Frog` at 13 is the longest name here, and that budget
 * is why a creature like `Flatwoods Monster` cannot be added under its own name.
 * `cryptid-forms.test.ts` asserts both halves of the arithmetic, so the cap moves
 * on its own if a longer title is ever added.
 */

/**
 * The register a drawing is pitched in. Nothing at runtime branches on this — it
 * groups the preview gallery and is how the roster is kept from drifting entirely
 * cute or entirely grim. The roster is deliberately all four.
 */
export type CryptidMood = 'cute' | 'spooky' | 'eerie' | 'goofy';

export interface CryptidForm {
  /** Canonical species name. A title is prefixed at roll time: "Fogbound Mothman". */
  readonly creature: string;
  readonly mood: CryptidMood;
  /**
   * Substrings the offline generator matches a lowercased description against.
   * First match in roster order wins, so these are kept distinctive.
   */
  readonly keywords: readonly string[];
  /** Eyes arrive as two separate characters so a form can space them as it likes. */
  render(leftEye: string, rightEye: string, mouth: string): string;
}

/**
 * Faces. APPEND ONLY, never reorder: `random-persona.test.ts` pins `EYES[0]` and
 * `MOUTHS[0]` against a fixed draw, and reordering would silently rewrite what a
 * given sequence of random numbers — or a given generator seed — produces.
 *
 * The tail of each list is the cute end. Closed-happy eyes and a `w` mouth are
 * what turn a form drawn as a monster into the same creature being pleased about
 * something, which is most of why the roster reads as a range rather than a mood.
 */
export const EYES = ['oo', 'OO', '..', '^^', '**', '++', 'uu', '--', 'ee'] as const;
export const MOUTHS = ['^', '~', '-', 'v', '_', 'w', 'u', 'o'] as const;

const art = (...lines: string[]): string => lines.join('\n');

export const CRYPTID_FORMS: readonly CryptidForm[] = [
  // ---------------------------------------------------------------- cute
  // Compact, big eyes, small body. These are the ones that hit the 7px marker cap.
  {
    creature: 'Jackalope',
    mood: 'cute',
    // Phrases, not bare `rabbit`/`bunny` — those belong to `Bunny`, which is the
    // one someone asking for a rabbit means.
    keywords: ['jackalope', 'antlered rabbit', 'horned hare'],
    render: (l, r, m) => art(' \\Y/ \\Y/', ` ( ${l} ${r} )`, ` ( >${m}< )`, '  "   "'),
  },
  {
    creature: 'Wolpertinger',
    mood: 'cute',
    keywords: ['wolpertinger', 'bavaria', 'winged rabbit'],
    render: (l, r, m) => art(' \\Y/  \\Y/', ` (\\${l} ${r}/)`, `  \\ ${m} /`, "  '---'"),
  },
  {
    creature: 'Hodag',
    mood: 'cute',
    keywords: ['hodag', 'spike', 'spiny', 'wisconsin'],
    render: (l, r, m) => art(' /\\/\\/\\', `( ${l}  ${r} )`, ` \\ >${m}< /`, ' ^^  ^^'),
  },
  {
    creature: 'Squonk',
    mood: 'cute',
    keywords: ['squonk', 'sad', 'cry', 'weep', 'warty'],
    render: (l, r, m) => art('  .---.', ` ( ${l} ${r} )`, ` ' \\${m}/ '`, "  `---'"),
  },
  {
    creature: 'Tsuchinoko',
    mood: 'cute',
    keywords: ['tsuchinoko', 'snake', 'serpent', 'noodle'],
    render: (l, r, m) => art('  _.--._', ` ( ${l}  ${r} )`, `  \\__${m}__/`),
  },
  {
    creature: 'Kappa',
    mood: 'cute',
    keywords: ['kappa', 'turtle', 'river imp', 'shell'],
    render: (l, r, m) => art('  (___)', ` ( ${l} ${r} )`, `  \\ ${m} /`, ' d{___}b'),
  },
  {
    creature: 'Pukwudgie',
    mood: 'cute',
    keywords: ['pukwudgie', 'gnome', 'sprite', 'little'],
    render: (l, r, m) => art('  /^^^\\', ` ( ${l} ${r} )`, `  ) ${m} (`, "  '/ \\'"),
  },
  {
    creature: 'Tommyknocker',
    mood: 'cute',
    keywords: ['tommyknocker', 'miner', 'mine', 'lantern', 'tunnel'],
    render: (l, r, m) => art('  ,-O-.', ` ( ${l} ${r} )`, ` |  ${m}  |`, "  '- -'"),
  },
  {
    creature: 'Ogopogo',
    mood: 'cute',
    keywords: ['ogopogo', 'okanagan', 'hump'],
    render: (l, r, m) => art('   .-.', `  (${l} ${r})_`, `   \\${m}/  \`-.`),
  },
  {
    creature: 'Fur Trout',
    mood: 'cute',
    keywords: ['trout', 'fish', 'furry', 'stream'],
    render: (l, r, m) => art('  ,^^^^,', ` <( ${l} ${r} )><`, `  ' \\${m}/ '`),
  },
  {
    creature: 'Domovoi',
    mood: 'cute',
    keywords: ['domovoi', 'house', 'hearth', 'beard'],
    render: (l, r, m) => art('  ,---.', ` ( ${l} ${r} )`, `  ) ${m} (`, ' {~~~~~}'),
  },
  {
    creature: 'Nessie',
    mood: 'cute',
    keywords: ['nessie', 'loch', 'lake', 'water'],
    render: (l, r, m) => art('    .--.', `   ( ${l} ${r})`, `    \\_${m}_/`, ' ~~~~|~~~~'),
  },
  {
    creature: 'Puppy',
    mood: 'cute',
    // Deliberately no bare `dog`: it is a prefix of `dogman`, and since the cute
    // block is scanned first it would take that description away from `Dogman`.
    keywords: ['puppy', 'pup', 'good boy', 'tail'],
    render: (l, r, m) => art('  ,--. .--.', ` (   ${l} ${r}   )`, ` (   >${m}<   )`, "  `--' '--'"),
  },
  {
    creature: 'Kitty',
    mood: 'cute',
    keywords: ['kitty', 'cat', 'kitten', 'whisker'],
    render: (l, r, m) => art(' /\\_/\\', `( ${l}.${r} )`, ` > ${m} <`),
  },
  {
    creature: 'Bunny',
    mood: 'cute',
    keywords: ['bunny', 'rabbit', 'hare', 'hop'],
    render: (l, r, m) => art('  (\\_/)', ` ( ${l}.${r} )`, ` (")${m}(")`),
  },

  // -------------------------------------------------------------- spooky
  // The angular register the app shipped with, kept and extended.
  {
    creature: 'Mothman',
    mood: 'spooky',
    keywords: ['moth', 'wing', 'fly', 'bat', 'point pleasant'],
    render: (l, r, m) =>
      art(
        '  /\\     /\\',
        ' /  \\___/  \\',
        `((  ${l}   ${r}  ))`,
        ` \\\\   ${m}   //`,
        '   \\_/_\\_/'
      ),
  },
  {
    creature: 'Wendigo',
    mood: 'spooky',
    keywords: ['wendigo', 'antler', 'starve', 'winter', 'gaunt'],
    render: (l, r, m) =>
      art(' \\|/   \\|/', '  \\ \\_/ /', `  / ${l} ${r} \\`, ' (  ===  )', `  \\__${m}__/`),
  },
  {
    creature: 'Black Shuck',
    mood: 'spooky',
    keywords: ['shuck', 'black dog', 'norfolk'],
    render: (l, r, m) =>
      art('   /^---^\\', `  / ${l}   ${r} \\`, ` |    ${m}    |`, '  \\  ===  /', '   /|   |\\'),
  },
  {
    creature: 'Dogman',
    mood: 'spooky',
    keywords: ['dogman', 'wolf', 'michigan', 'snout'],
    render: (l, r, m) =>
      art('  /\\_/\\', ` / ${l} ${r} \\`, ` \\  ${m}  /`, '  |VVV|', ' /|   |\\'),
  },
  {
    creature: 'Goatman',
    mood: 'spooky',
    keywords: ['goat', 'horn', 'ram', 'hoof'],
    render: (l, r, m) =>
      art(' \\_/   \\_/', '  \\ /^\\ /', `  ( ${l} ${r} )`, `   \\ ${m} /`, '   _/ \\_'),
  },
  {
    creature: 'The Rake',
    mood: 'spooky',
    keywords: ['rake', 'claw', 'crouch', 'bedside'],
    render: (l, r, m) =>
      art('  .-----.', ` /  ${l} ${r}  \\`, ` \\   ${m}   /`, ' \\\\|   |//', '  ||   ||'),
  },
  {
    creature: 'Hellhound',
    mood: 'spooky',
    keywords: ['hellhound', 'hound', 'ember', 'brimstone'],
    render: (l, r, m) => art('  /^\\_/^\\', ` /  ${l} ${r}  \\`, ` |   ${m}   |`, ' /|_____|\\'),
  },
  {
    creature: 'Skinwalker',
    mood: 'spooky',
    keywords: ['skinwalker', 'shift', 'borrow', 'mimic'],
    render: (l, r, m) =>
      art('  .-. .-.', ' (  \\_/  )', ` | ${l}   ${r} |`, `  \\  ${m}  /`, '   \\_-_/'),
  },
  {
    creature: 'Crawler',
    mood: 'spooky',
    keywords: ['crawl', 'long', 'leg', 'tall', 'scuttle'],
    render: (l, r, m) =>
      art('   _____', `  / ${l} ${r} \\`, `  |  ${m}  |`, ' /|     |\\', '/_|     |_\\'),
  },
  {
    creature: 'Bell Witch',
    mood: 'spooky',
    keywords: ['witch', 'bell', 'hag', 'bonnet', 'curse'],
    render: (l, r, m) =>
      art('  .-~~~-.', ` ( ${l}   ${r} )`, `  \\  ${m}  /`, '   |WWW|', "   '---'"),
  },
  {
    creature: 'Grafton',
    mood: 'spooky',
    keywords: ['grafton', 'headless', 'white', 'slick'],
    render: (l, r, m) =>
      art('  ,-----.', ` /  ${l} ${r}  \\`, ` |   ${m}   |`, ' \\       /', "  '-._.-'"),
  },
  {
    creature: 'Jersey Devil',
    mood: 'spooky',
    keywords: ['jersey', 'devil', 'pine barrens', 'hoofed'],
    render: (l, r, m) =>
      art('  \\/ /^\\ \\/', `  /  ${l} ${r}  \\`, `  \\   ${m}   /`, '   \\/ V \\/'),
  },
  {
    // The mare that sits on your chest, not the bad dream named after her. Owns
    // the bare `horse` keyword; `Kelpie` is the one you have to ask for by name.
    creature: 'Nightmare',
    mood: 'spooky',
    keywords: ['nightmare', 'horse', 'mare', 'hoofbeat', 'gallop'],
    render: (l, r, m) =>
      art(' ~/\\   /\\', `~( ${l}   ${r} )`, ' ~\\     /', `   \\ ${m} /`, "    'V'"),
  },

  // --------------------------------------------------------------- eerie
  // Thin, tall, wrong-proportioned. Nothing here has feet.
  {
    creature: 'Grey',
    mood: 'eerie',
    keywords: ['grey', 'gray', 'alien', 'abduct', 'saucer'],
    render: (l, r, m) =>
      art('   ,---.', '  /     \\', ` |  ${l} ${r}  |`, `  \\  ${m}  /`, "   '---'"),
  },
  {
    creature: 'Hat Man',
    mood: 'eerie',
    keywords: ['hat', 'brim', 'sleep', 'paralysis'],
    render: (l, r, m) =>
      art('   .---.', '  _|___|_', ` |  ${l} ${r}  |`, `  \\  ${m}  /`, '   |___|'),
  },
  {
    creature: 'Slenderman',
    mood: 'eerie',
    keywords: ['slender', 'faceless', 'suit', 'woods'],
    render: (l, r, m) =>
      art('   .---.', `  | ${l} ${r} |`, `  |  ${m}  |`, ' \\|_____|/', ' /|     |\\'),
  },
  {
    creature: 'Nightcrawler',
    mood: 'eerie',
    keywords: ['nightcrawler', 'fresno', 'stilt', 'trouser'],
    render: (l, r, m) => art('   ,---.', `  ( ${l} ${r} )`, `   \\ ${m} /`, '    | |', '   _| |_'),
  },
  {
    creature: 'Owlman',
    mood: 'eerie',
    keywords: ['owl', 'bird', 'feather', 'cornwall'],
    render: (l, r, m) =>
      art('   .---.', `  / ${l} ${r} \\`, `  |  ${m}  |`, '  \\ /|\\ /', "   '---'"),
  },
  {
    creature: 'Wisp',
    mood: 'eerie',
    keywords: ['wisp', 'fog', 'mist', 'spirit', 'marsh'],
    render: (l, r, m) =>
      art('    .-.', `   (${l} ${r})`, ` .--\`${m}'--.`, ' (   /|\\   )', "  `- /_\\ -'"),
  },
  {
    creature: 'Shadow',
    mood: 'eerie',
    keywords: ['shadow', 'dark', 'corner', 'doorway'],
    render: (l, r, m) => art('   ,###,', `  # ${l} ${r} #`, `  #  ${m}  #`, "  '#####'"),
  },
  {
    creature: 'Van Meter',
    mood: 'eerie',
    keywords: ['van meter', 'iowa', 'glow', 'beacon'],
    render: (l, r, m) => art('    |', '  \\_^_/', ` <( ${l} ${r} )>`, `   \\ ${m} /`),
  },
  {
    creature: 'Veil',
    mood: 'eerie',
    keywords: ['veil', 'sheet', 'shroud', 'drape'],
    render: (l, r, m) => art('   .---.', `  ( ${l} ${r} )`, `  |  ${m}  |`, '  \\/\\/\\/'),
  },
  {
    creature: 'Drifter',
    mood: 'eerie',
    keywords: ['drift', 'float', 'wander', 'hover'],
    render: (l, r, m) => art("   .' '.", `  ( ${l} ${r} )`, `   ) ${m} (`, "  '.   .'"),
  },
  {
    creature: 'Watcher',
    mood: 'eerie',
    // Not bare `eyes` — `Eyeball` takes that, and this one is a body with four.
    keywords: ['watch', 'stare', 'too many eyes', 'vigil'],
    render: (l, r, m) =>
      art('  .-----.', ` | ${l}   ${r} |`, ` |   ${m}   |`, ` | ${l}   ${r} |`, "  '-----'"),
  },
  {
    creature: 'Strider',
    mood: 'eerie',
    keywords: ['stride', 'step', 'stalk', 'overpass'],
    render: (l, r, m) =>
      art('   ,---.', `  ( ${l} ${r} )`, `   \\ ${m} /`, '   /   \\', '  /     \\'),
  },
  {
    // The phantom locomotive: a service that still runs a line nobody maintains.
    // The eyes are its lit windows, so the wheels stay `o` while the face rolls.
    creature: 'Ghost Train',
    mood: 'eerie',
    keywords: ['train', 'rail', 'locomotive', 'whistle', 'platform'],
    render: (l, r, m) => art('  _ ,=====,', ` (_)| ${l} ${r} |`, ` |=||  ${m}  |`, " '-(o)--(o)"),
  },
  {
    // One eye, so the two eye characters become its glints and the mouth its
    // pupil. Every other form spends them on a face; this one spends all three
    // on the same eye, which is the whole joke.
    creature: 'Eyeball',
    mood: 'eerie',
    keywords: ['eyeball', 'eye', 'iris', 'pupil'],
    render: (l, r, m) => art('  \\|/ \\|/', ' ,--------,', `( ${l} (${m}) ${r} )`, " '--------'"),
  },

  // --------------------------------------------------------------- goofy
  // Chunky, mid-size, and they all have feet.
  {
    creature: 'Bigfoot',
    mood: 'goofy',
    keywords: ['bigfoot', 'sasquatch', 'footprint', 'ape'],
    render: (l, r, m) =>
      art('   .---.', `  ( ${l} ${r} )`, `  (  ${m}  )`, '  /     \\', ' _/     \\_'),
  },
  {
    creature: 'Yeti',
    mood: 'goofy',
    keywords: ['yeti', 'snow', 'himalaya', 'abominable'],
    render: (l, r, m) =>
      art('  ,~~~~~,', ` ( ${l}   ${r} )`, ` (   ${m}   )`, '  \\_   _/', '  d_/ \\_b'),
  },
  {
    creature: 'Chupacabra',
    mood: 'goofy',
    keywords: ['chupacabra', 'goatsucker', 'quill'],
    render: (l, r, m) => art('  ^ ^ ^ ^', ` /  ${l} ${r}  \\`, ` \\  -${m}-  /`, '  /|   |\\'),
  },
  {
    creature: 'Loveland Frog',
    mood: 'goofy',
    keywords: ['loveland', 'frog', 'toad', 'croak'],
    render: (l, r, m) => art(`  (${l}) (${r})`, '   \\___/', `  _/ ${m} \\_`, '  (_) (_)'),
  },
  {
    creature: 'Thunderbird',
    mood: 'goofy',
    keywords: ['thunderbird', 'thunder', 'storm', 'talon'],
    render: (l, r, m) => art(' \\~-~\\_/~-~/', `   \\ ${l} ${r} /`, `    \\ ${m} /`, "     'V'"),
  },
  {
    creature: 'Kraken',
    mood: 'goofy',
    keywords: ['kraken', 'tentacle', 'squid', 'deep'],
    render: (l, r, m) => art('   .---.', `  ( ${l} ${r} )`, `  (  ${m}  )`, ' ((|||||))'),
  },
  {
    creature: 'Death Worm',
    mood: 'goofy',
    keywords: ['worm', 'gobi', 'desert', 'burrow'],
    render: (l, r, m) => art('  .---.', ` ( ${l} ${r} )`, ` ( >${m}< )`, '  \\~~~\\'),
  },
  {
    creature: 'Champ',
    mood: 'goofy',
    keywords: ['champ', 'champlain', 'wake'],
    render: (l, r, m) => art('   .--.', `  ( ${l} ${r})`, `   \\_${m}_/`, ' ~~^~~^~~'),
  },
  {
    creature: 'Lizard Man',
    mood: 'goofy',
    keywords: ['lizard', 'scape ore', 'scale', 'swamp'],
    render: (l, r, m) => art('  ,^^^^^,', ` ( ${l}   ${r} )`, ` (   ${m}   )`, '  d|   |b'),
  },
  {
    creature: 'Kelpie',
    mood: 'goofy',
    // Not `horse` — that belongs to `Nightmare`, which is drawn as one.
    keywords: ['kelpie', 'drowning', 'loch side', 'bridle'],
    render: (l, r, m) => art('   /^\\/^\\', `  ( ${l}  ${r} )~`, `   \\  ${m}  /`, '   _/   \\_'),
  },
  {
    creature: 'Mapinguari',
    mood: 'goofy',
    keywords: ['mapinguari', 'sloth', 'amazon', 'jungle'],
    render: (l, r, m) =>
      art('  ,-----.', ` (  ${l} ${r}  )`, ' |       |', ` (   ${m}   )`, '  \\_/ \\_/'),
  },
  {
    creature: 'Bunyip',
    mood: 'goofy',
    keywords: ['bunyip', 'billabong', 'outback', 'reed'],
    render: (l, r, m) => art('  ,-----,', ` ( ${l}   ${r} )`, ` (   ${m}   )`, '  )~~~~~('),
  },
] as const;
