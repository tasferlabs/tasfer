export type KeyboardMenuInputSource = "hardware-keyboard" | "input-surface";

/** Touch-first devices still get keyboard menus when a physical key triggered them. */
export function shouldOpenKeyboardMenu(
  touchOnly: boolean,
  inputSource?: KeyboardMenuInputSource,
): boolean {
  return !touchOnly || inputSource === "hardware-keyboard";
}
