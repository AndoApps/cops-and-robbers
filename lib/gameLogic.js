javascriptexport const SYMBOLS = {
  HEIST: { id: 'HEIST', name: 'The Heist', icon: '💰', description: 'Rob someone\'s points in play', needsTarget: true, type: 'attack' },
  ARREST: { id: 'ARREST', name: 'Arrest Warrant', icon: '📜', description: 'Wipe target\'s points in play to zero', needsTarget: true, type: 'attack' },
  INSIDE_JOB: { id: 'INSIDE_JOB', name: 'Inside Job', icon: '🤝', description: 'Give $1,000 to someone', needsTarget: true, type: 'gift' },
  SWITCHEROO: { id: 'SWITCHEROO', name: 'Switcheroo', icon: '🔄', description: 'Swap points in play with someone', needsTarget: true, type: 'attack' },
  TIP_OFF: { id: 'TIP_OFF', name: 'Tip Off', icon: '📻', description: 'Pick the next grid square', needsTarget: false, type: 'power' },
  BULLETPROOF: { id: 'BULLETPROOF', name: 'Bulletproof', icon: '🦺', description: 'Block an attack (once)', needsTarget: false, type: 'defence' },
  FRAME_JOB: { id: 'FRAME_JOB', name: 'Frame Job', icon: '🪞', description: 'Reflect attack back at attacker (once)', needsTarget: false, type: 'defence' },
  CRIME_SPREE: { id: 'CRIME_SPREE', name: 'Crime Spree', icon: '⚡', description: 'Double your points in play', needsTarget: false, type: 'bonus' },
  VAULT: { id: 'VAULT', name: 'The Vault', icon: '🏦', description: 'Bank your points (auto)', needsTarget: false, type: 'auto' },
}

export const GRID_CONTENTS = [
  { type: 'symbol', value: 'HEIST' },
  { type: 'symbol', value: 'ARREST' },
  { type: 'symbol', value: 'INSIDE_JOB' },
  { type: 'symbol', value: 'SWITCHEROO' },
  { type: 'symbol', value: 'TIP_OFF' },
  { type: 'symbol', value: 'BULLETPROOF' },
  { type: 'symbol', value: 'FRAME_JOB' },
  { type: 'symbol', value: 'CRIME_SPREE' },
  { type: 'symbol', value: 'VAULT' },
  { type: 'symbol', value: 'VAULT' },
  ...Array(25).fill(null).map(() => ({ type: 'points', value: 500 })),
  ...Array(10).fill(null).map(() => ({ type: 'points', value: 1000 })),
  ...Array(4).fill(null).map(() => ({ type: 'points', value: 2000 })),
  { type: 'points', value: 5000 },
]

export const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
export const ROWS = [1, 2, 3, 4, 5, 6, 7]

export const ALL_GRID_REFS = []
for (const col of COLS) {
  for (const row of ROWS) {
    ALL_GRID_REFS.push(`${col}${row}`)
  }
}

export function shuffle(array) {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function generateGameCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

export function generateCallOrder() {
  return shuffle([...ALL_GRID_REFS])
}

export function formatDollars(amount) {
  return `$${amount.toLocaleString()}`
}

export function getCellDisplay(cell) {
  if (!cell) return { icon: '?', label: '?' }
  if (cell.type === 'points') {
    return { icon: formatDollars(cell.value), label: formatDollars(cell.value), isPoints: true }
  }
  if (cell.type === 'symbol') {
    const sym = SYMBOLS[cell.value]
    return { icon: sym.icon, label: sym.name, isSymbol: true, symbol: sym }
  }
  return { icon: '?', label: '?' }
}

export const ACTION_SYMBOLS = ['HEIST', 'ARREST', 'INSIDE_JOB', 'SWITCHEROO', 'TIP_OFF']
export const DEFENCE_SYMBOLS = ['BULLETPROOF', 'FRAME_JOB']
export const AUTO_SYMBOLS = ['VAULT', 'CRIME_SPREE']
