export type ProjectProfile =
  | 'auto'
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7';

export type ConcreteProjectProfile = Exclude<ProjectProfile, 'auto'>;

export const concreteProjectProfiles: ConcreteProjectProfile[] = [
  'P0',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7'
];

export function isConcreteProjectProfile(value: unknown): value is ConcreteProjectProfile {
  return typeof value === 'string' && (concreteProjectProfiles as readonly string[]).includes(value);
}
