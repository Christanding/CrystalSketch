export interface StructureSite {
  siteId: string;
  sourceAtomNumber?: number;
  displayAtomNumber?: number;
  originSiteId?: string;
  copyOffset?: [number, number, number];
  speciesIndex: number;
  fractionalPosition: [number, number, number];
  selectiveDynamics?: [boolean, boolean, boolean];
}

// Calculation data, before any wrapping, display copies, or visibility filters.
export interface PeriodicStructure {
  cell: { vectors: [number, number, number][] };
  species: string[];
  sites: StructureSite[];
}
