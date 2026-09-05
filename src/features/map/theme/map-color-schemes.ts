import type { MapPalette, MapRenderEffects, RampStop, Rgb } from '../core/types';

export interface MapPaletteInput {
  readonly bg: string;
  readonly accent: string;
  readonly terrain: readonly string[];
  readonly water: readonly string[];
  readonly park: readonly string[];
  readonly transit: string;
  /**
   * Built-ground ink. Optional: schemes authored before the buildings layer —
   * including any the user has already saved — fall back to `streetLabel`.
   */
  readonly building?: string;
  readonly streetLabel: string;
  readonly parkLabel: string;
  readonly effects?: MapRenderEffects;
}

export interface CustomMapColorSchemeInput {
  readonly name: string;
  readonly light: MapPaletteInput;
  readonly dark: MapPaletteInput;
}

export interface MapColorScheme {
  readonly id: string;
  readonly name: string;
  readonly light: MapPalette;
  readonly dark: MapPalette;
  readonly custom?: boolean;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function ramp(colors: readonly string[]): readonly RampStop[] {
  return colors.map((color, index) => ({
    t: index / (colors.length - 1),
    rgb: rgb(color),
  }));
}

function palette(input: MapPaletteInput): MapPalette {
  return {
    bg: rgb(input.bg),
    accent: rgb(input.accent),
    terr: ramp(input.terrain),
    water: ramp(input.water),
    park: ramp(input.park),
    transit: rgb(input.transit),
    building: rgb(input.building ?? input.streetLabel),
    streetLabel: rgb(input.streetLabel),
    parkLabel: rgb(input.parkLabel),
    ...(input.effects ? { effects: input.effects } : {}),
  };
}

function scheme(
  id: string,
  name: string,
  light: MapPaletteInput,
  dark: MapPaletteInput
): MapColorScheme {
  return { id, name, light: palette(light), dark: palette(dark) };
}

export const DEFAULT_MAP_COLOR_SCHEME_ID = 'seattle';

export const BUILT_IN_MAP_COLOR_SCHEMES: readonly MapColorScheme[] = [
  scheme(
    'seattle',
    'Seattle',
    {
      bg: '#ECF0F4',
      accent: '#D67C1A',
      terrain: ['#B0BEC8', '#6C8494', '#34546A', '#142C40'],
      water: ['#96C0E0', '#4A8CC4', '#1E68AA'],
      park: ['#9EC8A8', '#50A46E', '#228050'],
      transit: '#7C4AB0',
      building: '#1B3B50',
      streetLabel: '#2E4E62',
      parkLabel: '#1E6E4E',
    },
    {
      bg: '#09121E',
      accent: '#F0A640',
      terrain: ['#22424A', '#2E7882', '#78C4C6', '#D4ECEA'],
      water: ['#1A4A80', '#266EB0', '#56A8E8'],
      park: ['#1E543A', '#368C56', '#78CE84'],
      transit: '#B28AF0',
      building: '#8FBEC4',
      streetLabel: '#B8D0D8',
      parkLabel: '#84C696',
    }
  ),
  scheme(
    'portland',
    'Portland',
    {
      bg: '#F2EFE4',
      accent: '#C45D35',
      terrain: ['#CEC8B4', '#9A9278', '#625E4B', '#302F28'],
      water: ['#ABC9C6', '#6A9E9A', '#386F72'],
      park: ['#B9C89C', '#819B62', '#506C3A'],
      transit: '#8A5A44',
      building: '#3B392E',
      streetLabel: '#514F43',
      parkLabel: '#49613A',
    },
    {
      bg: '#171914',
      accent: '#F08A5D',
      terrain: ['#3A3D31', '#696B54', '#A6A887', '#E2DFC5'],
      water: ['#244A4A', '#397878', '#72B1AC'],
      park: ['#30452C', '#587447', '#9AB577'],
      transit: '#D59B7E',
      building: '#BFBDA2',
      streetLabel: '#D1CEB9',
      parkLabel: '#A8BE87',
    }
  ),
  scheme(
    'kyoto',
    'Kyoto',
    {
      bg: '#F2ECF6',
      accent: '#E05278',
      terrain: ['#C9BED3', '#9180AA', '#5F4D7B', '#302540'],
      water: ['#AFC9EC', '#728DD0', '#4A58A7'],
      park: ['#B6D5CC', '#70A99B', '#3E776F'],
      transit: '#287F96',
      building: '#43355C',
      streetLabel: '#584A6B',
      parkLabel: '#386B63',
    },
    {
      bg: '#100D20',
      accent: '#FF7896',
      terrain: ['#332B52', '#665B98', '#AAA3D0', '#F0ECFF'],
      water: ['#202B68', '#4153B0', '#7895EE'],
      park: ['#243F48', '#397780', '#70C1B5'],
      transit: '#69D4E7',
      building: '#B6AEDC',
      streetLabel: '#D2CBE8',
      parkLabel: '#91D4C9',
    }
  ),
  scheme(
    'marrakesh',
    'Marrakesh',
    {
      bg: '#FFF3E6',
      accent: '#F04E23',
      terrain: ['#E8DDD8', '#D5C2BF', '#A9777C', '#8D4E68', '#D85A32', '#FF8A2A', '#D34A12'],
      water: ['#D7F0F2', '#82CAD2', '#278CA4'],
      park: ['#E1E8BE', '#A8C96F', '#568A52'],
      transit: '#8D3FB0',
      building: '#5A3140',
      streetLabel: '#684050',
      parkLabel: '#426A43',
      effects: { neonGlow: 0.16, scanlines: 0.06 },
    },
    {
      bg: '#170D19',
      accent: '#FF5A2A',
      terrain: ['#21121F', '#32182C', '#55243C', '#7C3150', '#C94A3D', '#FF7A2F', '#FFD166'],
      water: ['#101D3D', '#174D78', '#2AA8C0'],
      park: ['#253329', '#52643A', '#9DAF4B'],
      transit: '#E18AF0',
      building: '#E8B08C',
      streetLabel: '#FFD6B5',
      parkLabel: '#CAD477',
      effects: { neonGlow: 0.56, scanlines: 0.18 },
    }
  ),
  scheme(
    'miami',
    'Miami',
    {
      bg: '#F7E9FF',
      accent: '#F03F9C',
      terrain: ['#D7B8EC', '#9B73CF', '#68439D', '#34205F'],
      water: ['#9DE9F2', '#3BC7DD', '#1682B2'],
      park: ['#B8F0D0', '#55CE9E', '#239070'],
      transit: '#FF6B35',
      building: '#452663',
      streetLabel: '#593376',
      parkLabel: '#237B67',
    },
    {
      bg: '#100425',
      accent: '#FF3CAC',
      terrain: ['#301060', '#6A1B9A', '#B13FD0', '#F4C4FF'],
      water: ['#071C58', '#075EA8', '#00D4E8'],
      park: ['#10394D', '#087F84', '#35F2B2'],
      transit: '#FF8A32',
      building: '#D9A6F0',
      streetLabel: '#F0C5FF',
      parkLabel: '#6CFFD0',
    }
  ),
  scheme(
    'reykjavik',
    'Reykjavik',
    {
      bg: '#E9FFF8',
      accent: '#7B3FF2',
      terrain: ['#B6E9DA', '#61C8B7', '#258C91', '#17485E'],
      water: ['#A5E5FF', '#42AEE0', '#3368BC'],
      park: ['#C5F58A', '#72D65A', '#22A568'],
      transit: '#E149A9',
      building: '#17485E',
      streetLabel: '#245C69',
      parkLabel: '#19744F',
    },
    {
      bg: '#061C2B',
      accent: '#B07CFF',
      terrain: ['#10394D', '#117B7A', '#2EC99D', '#C0FFD4'],
      water: ['#0A3267', '#176FB0', '#45C8F0'],
      park: ['#164D42', '#27A65E', '#A3F55F'],
      transit: '#FF68C3',
      building: '#9EE3D2',
      streetLabel: '#C4FFF0',
      parkLabel: '#B9FF83',
    }
  ),
  scheme(
    'tokyo',
    'Tokyo',
    {
      bg: '#EEF1F5',
      accent: '#F0008C',
      terrain: ['#D9DEE6', '#C3C8D2', '#ADB4C2', '#554575', '#176B88', '#087C9E', '#A00072'],
      water: ['#D4F4FA', '#78D7E8', '#008EAE'],
      park: ['#D9F5E8', '#76D9AB', '#168768'],
      transit: '#E000A8',
      building: '#232838',
      streetLabel: '#30364A',
      parkLabel: '#116B57',
      effects: { neonGlow: 0.2, scanlines: 0.12 },
    },
    {
      bg: '#070912',
      accent: '#FF2DAA',
      terrain: ['#0D101D', '#151529', '#22203D', '#492D70', '#087C9E', '#00D5F5', '#FF46C4'],
      water: ['#07172F', '#0A4770', '#00BBD4'],
      park: ['#09251F', '#0B604A', '#42F5AD'],
      transit: '#FF2DAA',
      building: '#AFC6CE',
      streetLabel: '#D5E7EC',
      parkLabel: '#74F7C2',
      effects: { neonGlow: 0.75, scanlines: 0.42 },
    }
  ),
] as const;

export function findMapColorScheme(id: string, custom: MapColorScheme | null): MapColorScheme {
  if (id === custom?.id) return custom;
  return (
    BUILT_IN_MAP_COLOR_SCHEMES.find((candidate) => candidate.id === id) ??
    BUILT_IN_MAP_COLOR_SCHEMES[0]
  );
}

function validatePalette(value: unknown, path: string): MapPaletteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const color = (
    key: Exclude<keyof MapPaletteInput, 'terrain' | 'water' | 'park' | 'effects'>
  ): string => {
    const candidate = input[key];
    if (typeof candidate !== 'string' || !HEX_COLOR.test(candidate)) {
      throw new Error(`${path}.${key} must be a six-digit hex color`);
    }
    return candidate.toUpperCase();
  };
  const colors = (key: 'terrain' | 'water' | 'park'): string[] => {
    const candidate = input[key];
    if (!Array.isArray(candidate) || candidate.length < 2 || candidate.length > 7) {
      throw new Error(`${path}.${key} must contain 2 to 7 hex colors`);
    }
    return candidate.map((item, index) => {
      if (typeof item !== 'string' || !HEX_COLOR.test(item)) {
        throw new Error(`${path}.${key}[${index}] must be a six-digit hex color`);
      }
      return item.toUpperCase();
    });
  };

  const effects = input.effects;
  if (
    effects !== undefined &&
    (!effects || typeof effects !== 'object' || Array.isArray(effects))
  ) {
    throw new Error(`${path}.effects must be an object`);
  }
  const validatedEffects: MapRenderEffects | undefined = effects
    ? Object.fromEntries(
        (['neonGlow', 'scanlines'] as const).flatMap((key) => {
          const value = (effects as Record<string, unknown>)[key];
          if (value === undefined) return [];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error(`${path}.effects.${key} must be a number from 0 to 1`);
          }
          return [[key, value]];
        })
      )
    : undefined;

  const optionalColor = (key: 'building'): string | undefined => {
    const candidate = input[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string' || !HEX_COLOR.test(candidate)) {
      throw new Error(`${path}.${key} must be a six-digit hex color`);
    }
    return candidate.toUpperCase();
  };
  const building = optionalColor('building');

  return {
    bg: color('bg'),
    accent: color('accent'),
    terrain: colors('terrain'),
    water: colors('water'),
    park: colors('park'),
    transit: color('transit'),
    ...(building ? { building } : {}),
    streetLabel: color('streetLabel'),
    parkLabel: color('parkLabel'),
    ...(validatedEffects ? { effects: validatedEffects } : {}),
  };
}

export function parseCustomMapColorScheme(json: string): {
  readonly input: CustomMapColorSchemeInput;
  readonly scheme: MapColorScheme;
} {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('Custom palette must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Custom palette must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.trim().length === 0) {
    throw new Error('Custom palette needs a name');
  }
  const name = record.name.trim().slice(0, 40);
  const input: CustomMapColorSchemeInput = {
    name,
    light: validatePalette(record.light, 'light'),
    dark: validatePalette(record.dark, 'dark'),
  };
  return {
    input,
    scheme: {
      id: 'custom',
      name,
      light: palette(input.light),
      dark: palette(input.dark),
      custom: true,
    },
  };
}

export const CUSTOM_MAP_COLOR_SCHEME_TEMPLATE = JSON.stringify(
  {
    name: 'My palette',
    light: {
      bg: '#F1F3F5',
      accent: '#D97706',
      terrain: ['#CBD5E1', '#64748B', '#1E293B'],
      water: ['#BAE6FD', '#0284C7'],
      park: ['#BBF7D0', '#15803D'],
      transit: '#7C3AED',
      building: '#243447',
      streetLabel: '#334155',
      parkLabel: '#166534',
    },
    dark: {
      bg: '#0F172A',
      accent: '#FBBF24',
      terrain: ['#334155', '#94A3B8', '#F1F5F9'],
      water: ['#075985', '#38BDF8'],
      park: ['#14532D', '#86EFAC'],
      transit: '#C4B5FD',
      building: '#94A3B8',
      streetLabel: '#CBD5E1',
      parkLabel: '#BBF7D0',
    },
  } satisfies CustomMapColorSchemeInput,
  null,
  2
);
