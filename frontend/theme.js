// Shared UI constants. Block colours are not here: they encode gameplay properties (see appearance.js).
import { vulnHue } from './appearance.js';

export const KIND_LABELS = {
  language: 'Language',
  runtime: 'Runtime',
  system: 'System lib',
  package_manager: 'Package manager',
  build_tool: 'Build tool',
  container: 'Container',
  ci: 'CI action',
  package: 'Package',
  project: 'Your project',
};

export const PLAYER_COLORS = ['#e4572e', '#1b998b', '#7b5ea7', '#d99a00'];

/** CVSS severity bands (score -> colour + label) for the info panel, on the same hue scale as the blocks. */
export function cvssBand(score) {
  if (score == null) return { color: '#8a7b68', label: 'unknown' };
  const color = `hsl(${vulnHue(score).toFixed(0)}, 80%, 40%)`;
  if (score >= 9) return { color, label: 'critical' };
  if (score >= 7) return { color, label: 'high' };
  if (score >= 4) return { color, label: 'medium' };
  return { color, label: 'low' };
}
