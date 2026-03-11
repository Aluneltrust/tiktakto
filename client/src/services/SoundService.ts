// ============================================================================
// SoundService — Preloaded audio for game events
// ============================================================================

const SOUNDS = {
  placeX: '/sounds/place-x.mp3',
  placeO: '/sounds/place-o.mp3',
  invalid: '/sounds/invalid.mp3',
  turn: '/sounds/turn.mp3',
  matchFound: '/sounds/match-found.mp3',
  deposit: '/sounds/deposit.mp3',
  challenge: '/sounds/challenge.mp3',
  countdown: '/sounds/countdown.mp3',
  timerWarning: '/sounds/timer-warning.mp3',
  walletUnlock: '/sounds/wallet-unlock.mp3',
  win: '/sounds/win.mp3',
  lose: '/sounds/lose.mp3',
  draw: '/sounds/draw.mp3',
  drawOffer: '/sounds/draw-offer.mp3',
  resign: '/sounds/resign.mp3',
  click: '/sounds/click.mp3',
  hover: '/sounds/hover.mp3',
} as const;

type SoundName = keyof typeof SOUNDS;

const cache = new Map<string, HTMLAudioElement>();

function preload(name: SoundName) {
  const src = SOUNDS[name];
  if (cache.has(src)) return;
  const audio = new Audio(src);
  audio.preload = 'auto';
  audio.volume = 0.5;
  cache.set(src, audio);
}

export function preloadAll() {
  (Object.keys(SOUNDS) as SoundName[]).forEach(preload);
}

export function play(name: SoundName, volume = 0.5) {
  const src = SOUNDS[name];
  const cached = cache.get(src);
  if (cached) {
    const clone = cached.cloneNode() as HTMLAudioElement;
    clone.volume = volume;
    clone.play().catch(() => {});
  } else {
    const audio = new Audio(src);
    audio.volume = volume;
    audio.play().catch(() => {});
    cache.set(src, audio);
  }
}

export const sfx = { play, preloadAll };
