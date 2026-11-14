// Colours shared by the 3D blocks and the HTML legend.

export const KIND_COLORS = {
  language: '#f08a5d',
  runtime: '#f4c95d',
  system: '#b9a2dc',
  package_manager: '#86cfae',
  build_tool: '#78b4ea',
  container: '#7fd1d6',
  ci: '#ee9fb8',
};

export const ECO_COLORS = {
  npm: '#ea9890',
  pypi: '#92bde3',
  cargo: '#e5ab75',
  go: '#93d6df',
  maven: '#d6a0d6',
  rubygems: '#e98aa0',
  composer: '#a8a6e0',
  nuget: '#8fb0e8',
  hex: '#c3a1e8',
  pub: '#8fd8c8',
};

export const KIND_LABELS = {
  language: 'Language',
  runtime: 'Runtime',
  system: 'System lib',
  package_manager: 'Package manager',
  build_tool: 'Build tool',
  container: 'Container',
  ci: 'CI action',
  package: 'Package',
};

export const PLAYER_COLORS = ['#e4572e', '#1b998b'];

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function colorFor(dep) {
  if (dep.kind !== 'package' && KIND_COLORS[dep.kind]) return KIND_COLORS[dep.kind];
  const eco = (dep.ecosystem || '').toLowerCase();
  if (ECO_COLORS[eco]) return ECO_COLORS[eco];
  return `hsl(${hashHue(eco || 'x')}, 55%, 76%)`;
}
