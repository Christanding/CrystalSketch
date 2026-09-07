// Radii from the original CuI cartoon renderer (MIT, sanguangnian6699).
// Legacy color fallbacks; active illustration colors live in data/colormaps.
// Bond radii and displayed sphere radii intentionally have different meanings.
const ELEMENTS: Record<string, [color: string, bondRadius: number, atomRadius: number]> = {
  H: ["#fff8f3", .32, .32], C: ["#99a4b9", .75, .75],
  N: ["#8daff0", .71, .71], O: ["#f49b9e", .63, .63],
  F: ["#a8dca5", .64, .64], Si: ["#c4b4ea", 1.11, 1.11],
  P: ["#f5bb89", 1.07, 1.07], S: ["#f3da78", 1.03, 1.04],
  Cl: ["#bae3a5", .99, .99], Fe: ["#efa194", 1.32, 1.26],
  Co: ["#cda0de", 1.26, 1.25], Ni: ["#a0d9c4", 1.24, 1.24],
  Zn: ["#b39ae6", 1.22, 1.37], Ge: ["#9caee7", 1.20, 1.22],
  Se: ["#f3bca4", 1.20, 1.04], Sn: ["#becbdb", 1.39, 1.58],
  Te: ["#d59fd4", 1.38, 1.37], Pb: ["#a9b8d4", 1.46, 1.75],
  Cu: ["#f1abbc", 1.32, 1.28], I: ["#97cff2", 1.33, 1.33],
  Ru: ["#9bdad7", 1.46, 1.46], Rh: ["#c5b7e7", 1.42, 1.42],
  Pd: ["#aacadb", 1.39, 1.39], Pt: ["#d6dce7", 1.36, 1.36],
  Au: ["#efd190", 1.36, 1.36],
};

export function cartoonElement(symbol: string) {
  const [color, bondRadius, atomRadius] = ELEMENTS[symbol] ?? ["#c4b5de", 1, 1];
  return { color, bondRadius, atomRadius };
}
