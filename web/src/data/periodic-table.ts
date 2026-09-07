export type ElementCategory = "alkali" | "alkalineEarth" | "transition" | "postTransition" | "metalloid"
  | "nonmetal" | "halogen" | "noble" | "lanthanide" | "actinide" | "unknown";

export interface PeriodicTableElement {
  atomicNumber: number;
  symbol: string;
  nameEn: string;
  nameZh: string;
  column: number;
  row: number;
  category: ElementCategory;
}

// Display metadata only; no masses, radii, or bonding parameters are inferred here.
// Names/symbols: IUPAC periodic table and the Chinese national element naming decisions.
const ELEMENT_NAMES = `
H Hydrogen 氢
He Helium 氦
Li Lithium 锂
Be Beryllium 铍
B Boron 硼
C Carbon 碳
N Nitrogen 氮
O Oxygen 氧
F Fluorine 氟
Ne Neon 氖
Na Sodium 钠
Mg Magnesium 镁
Al Aluminium 铝
Si Silicon 硅
P Phosphorus 磷
S Sulfur 硫
Cl Chlorine 氯
Ar Argon 氩
K Potassium 钾
Ca Calcium 钙
Sc Scandium 钪
Ti Titanium 钛
V Vanadium 钒
Cr Chromium 铬
Mn Manganese 锰
Fe Iron 铁
Co Cobalt 钴
Ni Nickel 镍
Cu Copper 铜
Zn Zinc 锌
Ga Gallium 镓
Ge Germanium 锗
As Arsenic 砷
Se Selenium 硒
Br Bromine 溴
Kr Krypton 氪
Rb Rubidium 铷
Sr Strontium 锶
Y Yttrium 钇
Zr Zirconium 锆
Nb Niobium 铌
Mo Molybdenum 钼
Tc Technetium 锝
Ru Ruthenium 钌
Rh Rhodium 铑
Pd Palladium 钯
Ag Silver 银
Cd Cadmium 镉
In Indium 铟
Sn Tin 锡
Sb Antimony 锑
Te Tellurium 碲
I Iodine 碘
Xe Xenon 氙
Cs Caesium 铯
Ba Barium 钡
La Lanthanum 镧
Ce Cerium 铈
Pr Praseodymium 镨
Nd Neodymium 钕
Pm Promethium 钷
Sm Samarium 钐
Eu Europium 铕
Gd Gadolinium 钆
Tb Terbium 铽
Dy Dysprosium 镝
Ho Holmium 钬
Er Erbium 铒
Tm Thulium 铥
Yb Ytterbium 镱
Lu Lutetium 镥
Hf Hafnium 铪
Ta Tantalum 钽
W Tungsten 钨
Re Rhenium 铼
Os Osmium 锇
Ir Iridium 铱
Pt Platinum 铂
Au Gold 金
Hg Mercury 汞
Tl Thallium 铊
Pb Lead 铅
Bi Bismuth 铋
Po Polonium 钋
At Astatine 砹
Rn Radon 氡
Fr Francium 钫
Ra Radium 镭
Ac Actinium 锕
Th Thorium 钍
Pa Protactinium 镤
U Uranium 铀
Np Neptunium 镎
Pu Plutonium 钚
Am Americium 镅
Cm Curium 锔
Bk Berkelium 锫
Cf Californium 锎
Es Einsteinium 锿
Fm Fermium 镄
Md Mendelevium 钔
No Nobelium 锘
Lr Lawrencium 铹
Rf Rutherfordium 𬬻
Db Dubnium 𬭊
Sg Seaborgium 𬭳
Bh Bohrium 𬭛
Hs Hassium 𬭶
Mt Meitnerium 鿏
Ds Darmstadtium 𫟼
Rg Roentgenium 𬬭
Cn Copernicium 鿔
Nh Nihonium 鿭
Fl Flerovium 𫓧
Mc Moscovium 镆
Lv Livermorium 𫟷
Ts Tennessine 鿬
Og Oganesson 鿫
`.trim().split("\n");

function tablePosition(number: number): { row: number; column: number } {
  if (number <= 2) return { row: 1, column: number === 1 ? 1 : 18 };
  if (number <= 10) return { row: 2, column: number <= 4 ? number - 2 : number + 8 };
  if (number <= 18) return { row: 3, column: number <= 12 ? number - 10 : number };
  if (number <= 36) return { row: 4, column: number - 18 };
  if (number <= 54) return { row: 5, column: number - 36 };
  if (number <= 56) return { row: 6, column: number - 54 };
  if (number <= 71) return { row: 9, column: number - 54 };
  if (number <= 86) return { row: 6, column: number - 68 };
  if (number <= 88) return { row: 7, column: number - 86 };
  if (number <= 103) return { row: 10, column: number - 86 };
  return { row: 7, column: number - 100 };
}

function elementCategory(number: number, column: number): ElementCategory {
  if (number >= 109) return "unknown";
  if (number >= 57 && number <= 71) return "lanthanide";
  if (number >= 89 && number <= 103) return "actinide";
  if (column === 18) return "noble";
  if (column === 17) return "halogen";
  if (column === 1 && number !== 1) return "alkali";
  if (column === 2) return "alkalineEarth";
  if (column >= 3 && column <= 12) return "transition";
  if ([5, 14, 32, 33, 51, 52].includes(number)) return "metalloid";
  if ([1, 6, 7, 8, 15, 16, 34].includes(number)) return "nonmetal";
  return "postTransition";
}

export const PERIODIC_TABLE_ELEMENTS: readonly PeriodicTableElement[] = ELEMENT_NAMES.map((line, index) => {
  const [symbol, nameEn, nameZh] = line.split(" ") as [string, string, string];
  const atomicNumber = index + 1;
  const position = tablePosition(atomicNumber);
  return { atomicNumber, symbol, nameEn, nameZh, ...position, category: elementCategory(atomicNumber, position.column) };
});

export const PERIODIC_ELEMENT_SYMBOLS = PERIODIC_TABLE_ELEMENTS.map(element => element.symbol);

export function findPeriodicElement(symbol: string | undefined): PeriodicTableElement | undefined {
  return PERIODIC_TABLE_ELEMENTS.find(element => element.symbol === symbol);
}

export function filterPeriodicElements(query: string): readonly PeriodicTableElement[] {
  const search = query.trim().toLowerCase();
  if (!search) return PERIODIC_TABLE_ELEMENTS;
  const exact = PERIODIC_TABLE_ELEMENTS.find(element => element.symbol.toLowerCase() === search
    || String(element.atomicNumber) === search || element.nameZh === search);
  if (exact) return [exact];
  return PERIODIC_TABLE_ELEMENTS.filter(element => element.nameEn.toLowerCase().includes(search) || element.nameZh.includes(search));
}
