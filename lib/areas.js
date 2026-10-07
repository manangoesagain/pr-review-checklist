// The five review areas and three severity levels, shared by every step.

export const AREAS = [
  { id: 'security', name: 'Security' },
  { id: 'tests', name: 'Tests' },
  { id: 'breaking', name: 'Breaking changes' },
  { id: 'docs', name: 'Docs' },
  { id: 'performance', name: 'Performance' },
];

export const AREA_IDS = AREAS.map((area) => area.id);

export const SEVERITIES = ['must-fix', 'worth-asking', 'good-to-know'];

/** Most severe first; within a severity, in area order. */
export function compareItems(a, b) {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || AREA_IDS.indexOf(a.area) - AREA_IDS.indexOf(b.area);
}

/** "1 code file", "3 code files" */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
