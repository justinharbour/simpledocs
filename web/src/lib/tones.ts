// Ringtone and keypad tones are generated with WebAudio, so there are no asset files.
// Browsers keep an AudioContext suspended until the person has interacted with the page.
let context: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | undefined;

function audio(): AudioContext | null {
  if (!context) {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context = new Context();
  }
  return context;
}

export function unlockAudio(): boolean {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume();
  return ctx?.state === "running";
}
export const audioRunning = () => context?.state === "running";

function tone(frequencies: number[], seconds: number, volume: number) {
  const ctx = audio();
  if (!ctx || ctx.state !== "running") return;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const start = ctx.currentTime;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.setValueAtTime(volume, start + seconds - 0.03);
  gain.gain.linearRampToValueAtTime(0, start + seconds);
  for (const frequency of frequencies) {
    const oscillator = ctx.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(start + seconds + 0.01);
  }
}

const rows = [697, 770, 852, 941];
const columns = [1209, 1336, 1477];
const keys = "123456789*0#";
export function playDtmf(digit: string) {
  const index = keys.indexOf(digit);
  if (index >= 0) tone([rows[Math.floor(index / 3)], columns[index % 3]], 0.12, 0.08);
}

export function startRingtone() {
  stopRingtone();
  unlockAudio();
  const ring = () => tone([440, 480], 1, 0.1);
  ring();
  ringTimer = setInterval(ring, 3000);
}
export function stopRingtone() {
  if (ringTimer !== undefined) clearInterval(ringTimer);
  ringTimer = undefined;
}
