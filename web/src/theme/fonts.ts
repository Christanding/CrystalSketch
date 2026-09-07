export const FIGURE_FONT_FAMILY = '"CrystalSketch Numerals", "LXGW WenKai", "LXGW WenKai Full", serif';

let fontsReady: Promise<unknown> | null = null;

export async function ensureFigureFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  fontsReady ??= Promise.all([
    document.fonts.load('500 16px "LXGW WenKai"', "abcCuI晶体"),
    document.fonts.load('400 16px "CrystalSketch Numerals"', "0123456789"),
    document.fonts.load('300 16px "CrystalSketch Numerals"', "0123456789"),
    document.fonts.load('500 16px "CrystalSketch Numerals"', "0123456789"),
    document.fonts.load('600 16px "CrystalSketch Numerals"', "0123456789"),
  ]).catch(error => { fontsReady = null; throw error; });
  await fontsReady;
}
