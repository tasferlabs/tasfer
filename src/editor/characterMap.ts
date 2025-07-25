import type {
  CharacterMap,
  CharacterPosition,
  ViewportBounds,
  ViewportState,
} from "./types";

const VIEWPORT_OVERSHOOT = 200;

export const createViewportBounds = (viewport: ViewportState): ViewportBounds => {
  return {
    top: -viewport.scrollY - VIEWPORT_OVERSHOOT,
    bottom: -viewport.scrollY + viewport.height + VIEWPORT_OVERSHOOT,
    left: -VIEWPORT_OVERSHOOT,
    right: viewport.width + VIEWPORT_OVERSHOOT,
    overshoot: VIEWPORT_OVERSHOOT,
  };
};

export const isPositionInViewport = (
  position: CharacterPosition,
  bounds: ViewportBounds
): boolean => {
  return (
    position.y >= bounds.top &&
    position.y <= bounds.bottom &&
    position.x >= bounds.left &&
    position.x <= bounds.right
  );
};

export const createCharacterKey = (
  blockIndex: number,
  textIndex: number
): string => {
  return `${blockIndex}:${textIndex}`;
};

export const parseCharacterKey = (key: string): [number, number] => {
  const [blockIndex, textIndex] = key.split(":").map(Number);
  return [blockIndex, textIndex];
};

export const createEmptyCharacterMap = (viewport: ViewportState): CharacterMap => {
  return {
    characters: new Map(),
    viewportBounds: createViewportBounds(viewport),
    blockCharacterRanges: new Map(),
  };
};

export const findCharacterAtPosition = (
  characterMap: CharacterMap,
  x: number,
  y: number
): CharacterPosition | null => {
  for (const [, charPos] of characterMap.characters) {
    if (
      x >= charPos.x &&
      x <= charPos.x + charPos.width &&
      y >= charPos.y &&
      y <= charPos.y + charPos.height
    ) {
      return charPos;
    }
  }
  return null;
};

export const findNearestCharacterPosition = (
  characterMap: CharacterMap,
  x: number,
  y: number
): CharacterPosition | null => {
  let nearestChar: CharacterPosition | null = null;
  let nearestDistance = Infinity;

  for (const [, charPos] of characterMap.characters) {
    const centerX = charPos.x + charPos.width / 2;
    const centerY = charPos.y + charPos.height / 2;
    const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestChar = charPos;
    }
  }

  return nearestChar;
};

export const getCharactersInRange = (
  characterMap: CharacterMap,
  startBlockIndex: number,
  startTextIndex: number,
  endBlockIndex: number,
  endTextIndex: number
): CharacterPosition[] => {
  const characters: CharacterPosition[] = [];

  for (const [, charPos] of characterMap.characters) {
    const isInRange =
      (charPos.blockIndex > startBlockIndex ||
        (charPos.blockIndex === startBlockIndex &&
          charPos.textIndex >= startTextIndex)) &&
      (charPos.blockIndex < endBlockIndex ||
        (charPos.blockIndex === endBlockIndex && charPos.textIndex <= endTextIndex));

    if (isInRange) {
      characters.push(charPos);
    }
  }

  return characters.sort((a, b) => {
    if (a.blockIndex !== b.blockIndex) {
      return a.blockIndex - b.blockIndex;
    }
    return a.textIndex - b.textIndex;
  });
};