export const SIMULATION_MODES = ['off', 'ambient', 'balanced', 'dynamic', 'custom'] as const;
export type SimulationMode = (typeof SIMULATION_MODES)[number];
