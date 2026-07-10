export const PAIRING_FIGURE_COUNT = 256;

interface FigurePart {
  name: string;
  lines: readonly [string, string];
}

export interface PairingFigure {
  index: number;
  name: string;
  art: string;
}

const HEADS: readonly FigurePart[] = [
  { name: 'round eyes', lines: ['  .-.  ', ' (o o) '] },
  { name: 'wide eyes', lines: ['  .-.  ', ' (O O) '] },
  { name: 'sleepy eyes', lines: ['  .-.  ', ' (- -) '] },
  { name: 'bright eyes', lines: ['  .-.  ', ' (^ ^) '] },
  { name: 'peaked head', lines: ['  /_\\  ', ' [o o] '] },
  { name: 'peaked cross eyes', lines: ['  /_\\  ', ' [x x] '] },
  { name: 'square head', lines: [' .---. ', ' |o o| '] },
  { name: 'square sleepy head', lines: [' .---. ', ' |- -| '] },
  { name: 'curly head', lines: ['  { }  ', ' {o o} '] },
  { name: 'curly wide eyes', lines: ['  { }  ', ' {O O} '] },
  { name: 'antenna head', lines: ['  .^.  ', ' (o o) '] },
  { name: 'antenna cross eyes', lines: ['  .^.  ', ' (x x) '] },
  { name: 'horned head', lines: ['  \\_/  ', ' <o o> '] },
  { name: 'horned wide eyes', lines: ['  \\_/  ', ' <O O> '] },
  { name: 'flat head', lines: ['  ===  ', ' [o o] '] },
  { name: 'flat bright eyes', lines: ['  ___  ', ' [^ ^] '] },
] as const;

const BODIES: readonly FigurePart[] = [
  { name: 'raised arms', lines: [' \\ | / ', '  / \\  '] },
  { name: 'wide arms', lines: [' --|-- ', '  / \\  '] },
  { name: 'low arms', lines: ['  \\|/  ', '  / \\  '] },
  { name: 'right wave', lines: ['  /|-- ', '  / \\  '] },
  { name: 'left wave', lines: [' --|\\  ', '  / \\  '] },
  { name: 'hands on hips', lines: ['  <|>  ', '  / \\  '] },
  { name: 'diamond body', lines: ['  /#\\  ', '  / \\  '] },
  { name: 'box body', lines: ['  [|]  ', '  / \\  '] },
  { name: 'wide feet', lines: ['  /|\\  ', ' _/ \\_ '] },
  { name: 'together feet', lines: ['  /|\\  ', '  | |  '] },
  { name: 'left step', lines: ['  /|\\  ', ' _/ |  '] },
  { name: 'right step', lines: ['  /|\\  ', '  | \\_ '] },
  { name: 'round body', lines: ['  (|)  ', '  / \\  '] },
  { name: 'tall body', lines: ['   |   ', '  /|\\  '] },
  { name: 'short body', lines: ['  -|-  ', '  / \\  '] },
  { name: 'crossed legs', lines: ['  /|\\  ', '  \\ /  '] },
] as const;

if (HEADS.length * BODIES.length !== PAIRING_FIGURE_COUNT) {
  throw new Error('pairing figure catalog must stay aligned with streetcryptid/pair/2');
}

export function isPairingFigureIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < PAIRING_FIGURE_COUNT;
}

export function pairingFigure(index: number): PairingFigure {
  if (!isPairingFigureIndex(index)) {
    throw new RangeError(`pairing figure index must be between 0 and ${PAIRING_FIGURE_COUNT - 1}`);
  }

  const head = HEADS[index >> 4];
  const body = BODIES[index & 0x0f];
  return {
    index,
    name: `${head.name}, ${body.name}`,
    art: [...head.lines, ...body.lines].join('\n'),
  };
}
